/**
 * 回复解析模块
 * 从模型回复中提取 thinking/answer 标签内容
 */

/**
 * 从文本中提取指定 XML 标签内的内容
 * @param {string} text
 * @param {string} tag
 * @returns {string|null}
 */
function extractTag(text, tag) {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * 解析回复，提取 thinking 和 answer
 * @param {string} text - 原始回复文本
 * @returns {{thinking: string|null, answer: string, raw: string}}
 */
function parseResponse(text) {
  return {
    thinking: extractTag(text, "thinking"),
    answer: extractTag(text, "answer") || text,
    raw: text,
  };
}

/**
 * 移除 thinking 块，只保留 answer
 * @param {string} text
 * @returns {string}
 */
function hideThinking(text) {
  const answer = extractTag(text, "answer");
  if (answer) return answer;
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, "").trim();
}

/**
 * 只保留思考内容
 * @param {string} text
 * @returns {string}
 */
function thinkingOnly(text) {
  return extractTag(text, "thinking") || "";
}

/**
 * 将解析结果注入到 Anthropic 格式的响应 content 数组中
 * 在 text block 之前插入解析后的 thinking block
 *
 * @param {object} responseBody - Anthropic API 响应体
 * @returns {object} 增强后的响应体
 */
function enrichAnthropicResponse(responseBody) {
  if (!responseBody || !responseBody.content) return responseBody;

  const textBlocks = responseBody.content.filter((b) => b.type === "text");
  const otherBlocks = responseBody.content.filter((b) => b.type !== "text");

  const enriched = [];
  for (const block of textBlocks) {
    const parsed = parseResponse(block.text);
    if (parsed.thinking) {
      enriched.push({
        type: "thinking",
        thinking: parsed.thinking,
      });
    }
    // 将原始 text block 的内容替换为纯 answer
    enriched.push({
      ...block,
      text: parsed.answer,
    });
  }

  return {
    ...responseBody,
    content: [...otherBlocks, ...enriched],
  };
}

module.exports = {
  extractTag,
  parseResponse,
  hideThinking,
  thinkingOnly,
  enrichAnthropicResponse,
};
