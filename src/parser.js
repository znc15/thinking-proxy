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
 * 从原始文本中剥离所有 XML 标签，只保留纯文本
 * 兜底处理：当 parseResponse 无法提取标签时使用
 */
function stripTags(text) {
  return text
    .replace(/<\/?thinking>/gi, "")
    .replace(/<\/?answer>/gi, "")
    .trim();
}

/**
 * 自动修复残缺标签：补上缺失的开头/结尾标签
 * 常见情况：模型漏写 <thinking> 开头，直接输出内容然后跟 </thinking>
 */
function autoFixTags(text) {
  let fixed = text;

  // 情况1: 漏了 <thinking> 开头，但以纯文本开头且后面有 </thinking>
  //   "推理内容...</thinking><answer>答案</answer>"
  if (!/^\s*</.test(fixed) && /<\/thinking>/i.test(fixed)) {
    fixed = "<thinking>" + fixed;
  }

  // 情况2: 有 <thinking> 开头但漏了 </thinking>，后面直接跟 <answer>
  //   "<thinking>推理...<answer>答案</answer>"
  if (/<thinking>/i.test(fixed) && /<answer>/i.test(fixed) && !/<\/thinking>/i.test(fixed)) {
    fixed = fixed.replace(/<thinking>/i, "<thinking>").replace(/(<thinking>[\s\S]*?)(<answer>)/i, "$1</thinking>$2");
  }

  // 情况3: 有 </thinking> 但没有 <thinking>，补上开头
  if (/<\/thinking>/i.test(fixed) && !/<thinking>/i.test(fixed)) {
    fixed = "<thinking>" + fixed;
  }

  // 情况4: 整个回复以 <answer> 开头（连 thinking 块都没有）
  if (/^\s*<answer>/i.test(fixed) && !/<thinking>/i.test(fixed)) {
    fixed = "<thinking>（用户请求处理）</thinking>" + fixed;
  }

  return fixed;
}

/**
 * 解析回复，提取 thinking 和 answer
 * 找不到标签时自动修复 + 兜底剥离
 */
function parseResponse(text) {
  const fixed = autoFixTags(text);
  const thinking = extractTag(fixed, "thinking");
  const answer = extractTag(fixed, "answer");

  if (thinking || answer) {
    return { thinking, answer: answer || stripTags(fixed), raw: text };
  }

  return { thinking: null, answer: stripTags(fixed), raw: text };
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
  autoFixTags,
};
