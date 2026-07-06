/**
 * 代理转发核心模块
 * 处理 Anthropic / OpenAI 两种格式的请求转发
 */

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

  // 透传部分客户端头（但覆盖 Authorization）
  const passthrough = [
    "anthropic-version",
    "anthropic-beta",
    "x-api-key",
    "accept",
  ];
  for (const key of passthrough) {
    const lk = key.toLowerCase();
    const val =
      reqHeaders[key] || reqHeaders[lk];
    if (val && key !== "x-api-key") {
      upstream[key] = val;
    }
  }

  return upstream;
}

/**
 * 处理 Anthropic 格式请求 (/v1/messages)
 * @param {object} body - 请求体
 * @param {object} headers - 客户端请求头
 * @returns {Promise<{status: number, body: object}>}
 */
async function proxyAnthropic(requestBody, reqHeaders) {
  const body = JSON.parse(JSON.stringify(requestBody));
  const model = body.model || "claude-sonnet-4-6";
  const modelCfg = config.getModelConfig(model);

  // 1. 提取 thinking effort / 深度标记
  const rawThinking = body.thinking;
  const effort = (rawThinking && rawThinking.effort) || null;
  const { depth, body: cleanedBody } = extractDepthFromBody(body, "anthropic");
  const finalDepth = depth || config.DEFAULT_THINKING_DEPTH;

  console.log(
    `[proxy] Anthropic | model=${model} | thinking=${modelCfg.thinking} | effort=${effort || "无"} | depth=${finalDepth}`
  );

  let finalBody = cleanedBody;

  switch (modelCfg.thinking) {
    case config.THINKING_TYPES.NATIVE:
      // 原生支持，透传 thinking 参数（包括 effort）
      if (effort) {
        console.log(`[proxy] 原生 thinking + effort=${effort}，透传`);
      } else {
        console.log(`[proxy] 原生 thinking 模式，透传`);
      }
      break;

    case config.THINKING_TYPES.PROMPT:
      // 不支持原生 thinking：
      // - 如果传了 thinking.effort → 映射为提示词深度
      // - 移除原始 thinking 参数后注入 system prompt
      const mappedDepth = effort ? resolveDepth(effort) : finalDepth;
      console.log(`[proxy] 提示词模拟模式, thinking.effort=${effort || "无"} → depth=${mappedDepth}`);
      delete finalBody.thinking;
      finalBody = injectThinkingPrompt(finalBody, mappedDepth, "anthropic");
      break;

    case config.THINKING_TYPES.NONE:
      // 不涉及，直接透传
      delete finalBody.thinking;
      console.log(`[proxy] 无 thinking 模式，直接透传`);
      break;
  }

  // 2. 转发到上游
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/messages`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  const responseBody = await response.json();

  if (!response.ok) {
    return {
      status: response.status,
      body: responseBody,
    };
  }

  // 3. 可选：解析回复中的 thinking 标签，注入为独立 block
  if (config.PARSE_THINKING_RESPONSE && modelCfg.thinking === config.THINKING_TYPES.PROMPT) {
    return {
      status: response.status,
      body: enrichAnthropicResponse(responseBody),
    };
  }

  return {
    status: response.status,
    body: responseBody,
  };
}

/**
 * 处理 OpenAI 格式请求 (/v1/chat/completions)
 * @param {object} body - 请求体
 * @param {object} headers - 客户端请求头
 * @returns {Promise<{status: number, body: object}>}
 */
async function proxyOpenAI(requestBody, reqHeaders) {
  const body = JSON.parse(JSON.stringify(requestBody));
  const model = body.model || "claude-sonnet-4-6";
  const modelCfg = config.getModelConfig(model);

  // 提取用户消息中的思考深度标记
  const { depth, body: cleanedBody } = extractDepthFromBody(body, "openai");
  const finalDepth = depth || config.DEFAULT_THINKING_DEPTH;

  console.log(
    `[proxy] OpenAI | model=${model} | thinking=${modelCfg.thinking} | depth=${finalDepth}`
  );

  let finalBody = cleanedBody;

  switch (modelCfg.thinking) {
    case config.THINKING_TYPES.PROMPT:
      // 提示词模拟模式，注入 system prompt
      finalBody = injectThinkingPrompt(finalBody, finalDepth, "openai");
      console.log(`[proxy] 提示词模拟模式，已注入 thinking prompt`);
      break;

    case config.THINKING_TYPES.NATIVE:
    case config.THINKING_TYPES.NONE:
    default:
      // 直接透传
      console.log(`[proxy] 直接透传模式`);
      break;
  }

  // 转发到上游
  const upstreamUrl = `${config.UPSTREAM_BASE_URL}/v1/chat/completions`;
  const upstreamHeaders = buildUpstreamHeaders(reqHeaders);

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(finalBody),
  });

  const responseBody = await response.json();

  if (!response.ok) {
    return {
      status: response.status,
      body: responseBody,
    };
  }

  // 可选解析 thinking 标签
  if (
    config.PARSE_THINKING_RESPONSE &&
    modelCfg.thinking === config.THINKING_TYPES.PROMPT
  ) {
    const enriched = enrichOpenAIResponse(responseBody);
    return { status: response.status, body: enriched };
  }

  return {
    status: response.status,
    body: responseBody,
  };
}

/**
 * 增强 OpenAI 格式响应：解析 thinking/answer 标签
 */
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
        // 将 thinking 附加到 message 上（OpenAI 没有原生 thinking block）
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
