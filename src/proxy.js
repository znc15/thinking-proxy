/**
 * 代理转发核心模块
 * 处理 Anthropic / OpenAI 两种格式的请求转发，支持流式与非流式
 */

const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const config = require("./config");
const { injectThinkingPrompt, extractDepthFromBody, resolveDepth } = require("./thinking");
const { enrichAnthropicResponse, parseResponse } = require("./parser");

/**
 * 构建上游请求头
 * @param {object} reqHeaders - 客户端请求头
 * @returns {object} 转发给上游的头
 */
function buildUpstreamHeaders(reqHeaders) {
  const upstream = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.UPSTREAM_API_KEY}`,
  };

  const passthrough = [
    "anthropic-version",
    "anthropic-beta",
    "x-api-key",
    "accept",
  ];
  for (const key of passthrough) {
    const lk = key.toLowerCase();
    const val = reqHeaders[key] || reqHeaders[lk];
    if (val && key !== "x-api-key") {
      upstream[key] = val;
    }
  }

  return upstream;
}

/**
 * 检测请求是否启用流式
 */
function isStreamRequest(body) {
  return body && body.stream === true;
}

/**
 * 准备发给上游的请求体（注入 thinking 提示词等）
 */
function prepareUpstreamBody(requestBody, reqHeaders, format) {
  const body = JSON.parse(JSON.stringify(requestBody));
  const model = body.model || "claude-sonnet-4-6";
  const modelCfg = config.getModelConfig(model);

  const rawThinking = body.thinking;
  const effort = (rawThinking && rawThinking.effort) || null;
  const { depth, body: cleanedBody } = extractDepthFromBody(body, format);
  const finalDepth = depth || config.DEFAULT_THINKING_DEPTH;

  console.log(
    `[proxy] ${format === "anthropic" ? "Anthropic" : "OpenAI"} | model=${model} | thinking=${modelCfg.thinking} | effort=${effort || "无"} | depth=${finalDepth} | stream=${!!isStreamRequest(body)}`
  );

  let finalBody = cleanedBody;

  switch (modelCfg.thinking) {
    case config.THINKING_TYPES.NATIVE:
      if (effort) {
        console.log(`[proxy] 原生 thinking + effort=${effort}，透传`);
      } else {
        console.log(`[proxy] 原生 thinking 模式，透传`);
      }
      break;

    case config.THINKING_TYPES.PROMPT: {
      const mappedDepth = effort ? resolveDepth(effort) : finalDepth;
      console.log(`[proxy] 提示词模拟模式, thinking.effort=${effort || "无"} → depth=${mappedDepth}`);
      delete finalBody.thinking;
      finalBody = injectThinkingPrompt(finalBody, mappedDepth, format);

      // 提示词模式不支持流式（需要完整回复才能解析 thinking 标签）
      if (finalBody.stream) {
        console.log(`[proxy] 提示词模式下强制关闭 stream（需要完整回复解析 thinking 块）`);
        finalBody.stream = false;
      }
      break;
    }

    case config.THINKING_TYPES.NONE:
      delete finalBody.thinking;
      console.log(`[proxy] 无 thinking 模式，直接透传`);
      break;
  }

  return { body: finalBody, modelCfg };
}

/**
 * 处理 Anthropic 格式的非流式请求
 */
async function proxyAnthropicNonStream(finalBody, modelCfg, reqHeaders) {
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/messages`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  const responseBody = await response.json();

  if (!response.ok) {
    return { status: response.status, body: responseBody };
  }

  if (config.PARSE_THINKING_RESPONSE && modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
    return { status: response.status, body: enrichAnthropicResponse(responseBody) };
  }

  return { status: response.status, body: responseBody };
}

/**
 * 处理 Anthropic 格式的流式请求 — 管道透传上游 SSE
 * 仅用于 native / none 模式（prompt 模式已在 prepareUpstreamBody 中关闭 stream）
 */
async function proxyAnthropicStream(finalBody, reqHeaders, res) {
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/messages`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    try {
      return { status: upstreamResp.status, body: JSON.parse(errText) };
    } catch {
      return { status: upstreamResp.status, body: { error: errText } };
    }
  }

  // 设置 SSE 响应头
  res.writeHead(upstreamResp.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // 使用 Node.js pipeline 管道直传（比手动 read/write 稳定）
  const nodeStream = Readable.fromWeb(upstreamResp.body);
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    console.error("[proxy] 流传输中断:", err.message);
  }
}

/**
 * 处理 Anthropic 格式请求 (/v1/messages)
 */
async function proxyAnthropic(requestBody, reqHeaders, res) {
  const { body: finalBody, modelCfg } = prepareUpstreamBody(requestBody, reqHeaders, "anthropic");

  if (isStreamRequest(finalBody)) {
    return proxyAnthropicStream(finalBody, reqHeaders, res);
  }
  return proxyAnthropicNonStream(finalBody, modelCfg, reqHeaders);
}

/**
 * 处理 OpenAI 格式的非流式请求
 */
async function proxyOpenAINonStream(finalBody, modelCfg, reqHeaders) {
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/chat/completions`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  const responseBody = await response.json();

  if (!response.ok) {
    return { status: response.status, body: responseBody };
  }

  if (config.PARSE_THINKING_RESPONSE && modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
    const enriched = enrichOpenAIResponse(responseBody);
    return { status: response.status, body: enriched };
  }

  return { status: response.status, body: responseBody };
}

/**
 * 处理 OpenAI 格式的流式请求 — 管道透传上游 SSE
 */
async function proxyOpenAIStream(finalBody, reqHeaders, res) {
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/chat/completions`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    try {
      return { status: upstreamResp.status, body: JSON.parse(errText) };
    } catch {
      return { status: upstreamResp.status, body: { error: errText } };
    }
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
    console.error("[proxy] OpenAI 流传输中断:", err.message);
  }
}

/**
 * 处理 OpenAI 格式请求 (/v1/chat/completions)
 */
async function proxyOpenAI(requestBody, reqHeaders, res) {
  const { body: finalBody, modelCfg } = prepareUpstreamBody(requestBody, reqHeaders, "openai");

  if (isStreamRequest(finalBody)) {
    return proxyOpenAIStream(finalBody, reqHeaders, res);
  }
  return proxyOpenAINonStream(finalBody, modelCfg, reqHeaders);
}

function enrichOpenAIResponse(responseBody) {
  if (!responseBody || !responseBody.choices) return responseBody;

  const choices = responseBody.choices.map((choice) => {
    const content = choice.message?.content || "";
    if (!content) return choice;

    const parsed = parseResponse(content);
    return {
      ...choice,
      message: {
        ...choice.message,
        content: parsed.answer,
        thinking_content: parsed.thinking || undefined,
      },
    };
  });

  return { ...responseBody, choices };
}

module.exports = {
  proxyAnthropic,
  proxyOpenAI,
  buildUpstreamHeaders,
};
