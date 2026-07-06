/**
 * 代理转发核心模块
 *
 * 三种 thinking 模式：
 * - native: 保留 thinking 参数透传
 * - prompt: 移除 thinking 参数，注入提示词 → 流式/非流式都通用
 * - none:   移除 thinking 参数，原始透传
 *
 * 流式：pipeline 管道直传上游 SSE
 * 非流式：fetch await response.json() → prompt 模式下解析 thinking 标签
 */

const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const config = require("./config");
const { injectThinkingPrompt, extractDepthFromBody, resolveDepth } = require("./thinking");
const { enrichAnthropicResponse, parseResponse } = require("./parser");

// ── 工具 ──────────────────────────────────────────────

function buildUpstreamHeaders(reqHeaders) {
  const upstream = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.UPSTREAM_API_KEY}`,
  };
  for (const key of ["anthropic-version", "anthropic-beta", "accept"]) {
    const val = reqHeaders[key] || reqHeaders[key.toLowerCase()];
    if (val) upstream[key] = val;
  }
  return upstream;
}

function isStreamRequest(body) {
  return body && body.stream === true;
}

// ── 核心：准备上游请求体 ──────────────────────────────

function prepareUpstreamBody(requestBody, format) {
  const body = JSON.parse(JSON.stringify(requestBody));
  const model = body.model || "claude-sonnet-4-6";
  const modelCfg = config.getModelConfig(model);

  const effort = (body.thinking && body.thinking.effort) || null;
  const { depth, body: cleanedBody } = extractDepthFromBody(body, format);
  const finalDepth = depth || config.DEFAULT_THINKING_DEPTH;

  const stream = isStreamRequest(body);
  console.log(
    `[proxy] ${format === "anthropic" ? "Anthropic" : "OpenAI"} | model=${model} | ` +
    `mode=${modelCfg.thinking} | effort=${effort || "-"} | depth=${finalDepth} | stream=${stream}`
  );

  let finalBody = cleanedBody;

  switch (modelCfg.thinking) {
    case config.THINKING_TYPES.NATIVE:
      console.log(`  → 原生 thinking，透传`);
      break;

    case config.THINKING_TYPES.PROMPT: {
      const mapped = effort ? resolveDepth(effort) : finalDepth;
      delete finalBody.thinking;
      finalBody = injectThinkingPrompt(finalBody, mapped, format);
      console.log(`  → 提示词模拟 (depth=${mapped}), stream=${stream}（流式正常透传）`);
      break;
    }

    case config.THINKING_TYPES.NONE:
      delete finalBody.thinking;
      console.log(`  → 透传模式`);
      break;
  }

  return { body: finalBody, model, modelCfg };
}

// ── 流式透传（prompt 模式需要解析标签后重新流式输出）──

async function proxyStreamRaw(upstreamUrl, finalBody, reqHeaders, res) {
  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(reqHeaders),
    body: JSON.stringify(finalBody),
  });

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    try { return JSON.parse(errText); } catch { return { error: errText }; }
  }

  res.writeHead(upstreamResp.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const nodeStream = Readable.fromWeb(upstreamResp.body);
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error("[proxy] 流中断:", err.message);
    }
  }
}

/**
 * prompt 模式流式：收集完整回复 → 解析 thinking/answer → 用 Anthropic SSE 格式输出
 */
async function proxyStreamParsed(upstreamUrl, finalBody, reqHeaders, res) {
  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(reqHeaders),
    body: JSON.stringify(finalBody),
  });

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    const errBody = (() => { try { return JSON.parse(errText); } catch { return { error: errText }; } })();
    res.status(upstreamResp.status).json(errBody);
    return;
  }

  // 收集完整文本
  const fullText = await upstreamResp.text();
  const parsed = parseResponse(fullText);

  // 以 Anthropic SSE 格式重新流式输出
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const lines = [];
  if (parsed.thinking) {
    lines.push(
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: parsed.thinking } })}`,
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      ""
    );
  }
  lines.push(
    "event: content_block_start",
    `data: {"type":"content_block_start","index":${parsed.thinking ? 1 : 0},"content_block":{"type":"text","text":""}}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: parsed.thinking ? 1 : 0, delta: { type: "text_delta", text: parsed.answer } })}`,
    "",
    "event: content_block_stop",
    `data: {"type":"content_block_stop","index":${parsed.thinking ? 1 : 0}}`,
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    ""
  );

  res.write(lines.join("\n"));
  res.end();
}

// ── 非流式 ─────────────────────────────────────────────

async function proxyNonStream(upstreamUrl, finalBody, modelCfg, reqHeaders) {
  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(reqHeaders),
    body: JSON.stringify(finalBody),
  });
  const responseBody = await response.json();
  if (!response.ok) return responseBody;

  // prompt 模式非流式：解析 thinking/answer 标签为独立 block
  if (config.PARSE_THINKING_RESPONSE && modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
    return enrichAnthropicResponse(responseBody);
  }
  return responseBody;
}

// ── 对外入口 ───────────────────────────────────────────

async function proxyAnthropic(requestBody, reqHeaders, res) {
  const { body: finalBody, modelCfg } = prepareUpstreamBody(requestBody, "anthropic");
  const url = `${config.UPSTREAM_BASE_URL}/v1/messages`;

  if (isStreamRequest(finalBody)) {
    if (modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
      // prompt 模式流式：先收集完整文本，解析后再以 SSE 格式输出
      await proxyStreamParsed(url, finalBody, reqHeaders, res);
    } else {
      // native/none 模式流式：管道直传
      await proxyStreamRaw(url, finalBody, reqHeaders, res);
    }
    return null;
  }
  return proxyNonStream(url, finalBody, modelCfg, reqHeaders);
}

async function proxyOpenAI(requestBody, reqHeaders, res) {
  const { body: finalBody, modelCfg } = prepareUpstreamBody(requestBody, "openai");
  const url = `${config.UPSTREAM_BASE_URL}/v1/chat/completions`;

  if (isStreamRequest(finalBody)) {
    if (modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
      await proxyStreamParsed(url, finalBody, reqHeaders, res);
    } else {
      await proxyStreamRaw(url, finalBody, reqHeaders, res);
    }
    return null;
  }

  const responseBody = await proxyNonStream(url, finalBody, modelCfg, reqHeaders);
  if (config.PARSE_THINKING_RESPONSE && modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
    return enrichOpenAIResponse(responseBody);
  }
  return responseBody;
}

// ── OpenAI 格式回复增强 ────────────────────────────────

function enrichOpenAIResponse(body) {
  if (!body || !body.choices) return body;
  return {
    ...body,
    choices: body.choices.map((c) => {
      const text = c.message?.content || "";
      if (!text) return c;
      const p = parseResponse(text);
      return { ...c, message: { ...c.message, content: p.answer, thinking_content: p.thinking || undefined } };
    }),
  };
}

module.exports = { proxyAnthropic, proxyOpenAI };
