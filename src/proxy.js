/**
 * 代理转发核心模块
 *
 * 三种 thinking 模式：
 * - native: 保留 thinking 参数透传，流式直接管道转发
 * - prompt: 移除 thinking 参数，注入提示词。
 *           流式请求 → 向该上游发 stream:false → 拿完整 JSON → 解析后模拟 SSE 流式发给客户端
 *           非流式请求 → 正常 fetch JSON → 解析 thinking/answer block
 * - none: 移除 thinking 参数，原始透传
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

/**
 * 模拟 Anthropic SSE 流式输出
 * 传入 thinking 和 answer 纯文本，逐 token 发送 SSE 事件
 */
async function emitSimulatedStream(res, model, thinking, answer) {
  const msgId = "msg_" + Math.random().toString(36).slice(2, 10);

  const write = (event, obj) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // message_start
  write("message_start", {
    type: "message_start",
    message: {
      type: "message",
      model,
      role: "assistant",
      id: msgId,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let index = 0;

  // thinking block
  if (thinking) {
    write("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });

    // 按字符逐 token 输出（3-10个字符一组，模拟自然流）
    for (const token of splitTokens(thinking)) {
      write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: token },
      });
      // 微延迟模拟流式节奏
      await sleep(5);
    }

    write("content_block_stop", { type: "content_block_stop", index });
    index++;
  }

  // text block
  write("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });

  for (const token of splitTokens(answer)) {
    write("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: token },
    });
    await sleep(8);
  }

  write("content_block_stop", { type: "content_block_stop", index });

  // message_delta + message_stop
  write("message_delta", {
    type: "message_delta",
    usage: { output_tokens: 0 },
    delta: { stop_reason: "end_turn" },
  });
  write("message_stop", { type: "message_stop" });
}

/**
 * 将文本按语义边界切分为 token 数组
 * 混合粒度：标点后切分、空格切分、固定长度兜底
 */
function splitTokens(text) {
  const tokens = [];
  // 先在常见标点后切分（保留标点在前一个 token 尾部）
  const parts = text.split(/(?<=[。，！？；：、\n])/g);
  for (const part of parts) {
    if (part.length <= 15) {
      if (part.trim()) tokens.push(part);
    } else {
      // 较长部分按空格再切
      const words = part.split(/(?<=\s)/g);
      for (const w of words) {
        if (w.length <= 12) {
          if (w.trim() || w === " ") tokens.push(w);
        } else {
          // 兜底：按固定长度切分
          for (let i = 0; i < w.length; i += 8) {
            tokens.push(w.slice(i, i + 8));
          }
        }
      }
    }
  }
  return tokens.filter(t => t.length > 0);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

// ── 流式透传（native / none 模式用） ────────────────────

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
 * prompt 模式流式：
 *   强制关掉上游的 stream → 发非流式请求拿到完整 JSON
 *   → 解析 thinking/answer → 用 emitSimulatedStream 模拟 SSE 输出
 */
async function proxyStreamParsed(upstreamUrl, finalBody, reqHeaders, res, model) {
  // 强制非流式从上游取结果
  const nonStreamBody = { ...finalBody, stream: false };

  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(reqHeaders),
    body: JSON.stringify(nonStreamBody),
  });

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    const errBody = (() => { try { return JSON.parse(errText); } catch { return { error: errText }; } })();
    res.status(upstreamResp.status).json(errBody);
    return;
  }

  const fullBody = await upstreamResp.json();

  // 提取纯文本（兼容 content 为数组或无 content）
  const blocks = fullBody.content || [];
  const rawText = blocks
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const parsed = parseResponse(rawText);

  await emitSimulatedStream(res, model, parsed.thinking, parsed.answer);
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
  const { body: finalBody, modelCfg, model } = prepareUpstreamBody(requestBody, "anthropic");
  const url = `${config.UPSTREAM_BASE_URL}/v1/messages`;

  if (isStreamRequest(finalBody)) {
    if (modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
      await proxyStreamParsed(url, finalBody, reqHeaders, res, model);
    } else {
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
      await proxyStreamParsed(url, finalBody, reqHeaders, res, modelCfg.label || "unknown");
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
