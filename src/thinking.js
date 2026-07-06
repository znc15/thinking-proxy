/**
 * 提示词管理模块
 * 为不支持原生 thinking 的模型生成模拟思考的 system prompt
 */

const THINKING_SYSTEM_PROMPTS = {
  quick: [
    "【系统级强制规则】每次回复必须包含 <thinking>...</thinking> 和 <answer>...</answer>。",
    "thinking 中写1-3句简要推理。即使简单问题也不可省略标签。",
  ].join("\n"),

  standard: [
    "===== 输出格式协议 v2.0 =====",
    "你每次回复的输出都将被程序自动解析。",
    "程序仅识别 <thinking> 和 <answer> 标签内的内容。",
    "不包含这两个标签的回复将被视为格式错误并丢弃。",
    "",
    "你的回复必须以 <thinking> 开头，这是绝对要求。",
    "",
    "正确格式（唯一接受的格式）：",
    "<thinking>",
    "逐步推理过程（问题理解→关键信息→方案分析→推导→验证）",
    "</thinking>",
    "",
    "<answer>",
    "最终答案",
    "</answer>",
    "",
    "规则（违规=格式错误）：",
    "1. 回复必须以 <thinking> 标签开头",
    "2. <thinking> 后必须跟 </thinking>，然后是 <answer> 和 </answer>",
    "3. 任何其他格式（如直接给答案、不带标签、标签变形）均不可接受",
    "4. 即使是最简单的问候也必须包含两对标签",
    "",
    "示例 — 用户问 1+1=？：",
    "<thinking>",
    "这是基础整数加法。1 个单位加 1 个单位得到 2。",
    "</thinking>",
    "<answer>",
    "1 + 1 = 2",
    "</answer>",
    "",
    "现在开始。你的第一条回复必须以 <thinking> 开头。",
  ].join("\n"),

  deep: [
    "【系统级强制规则 - 绝对不可违反】",
    "",
    "你每一次回复都必须严格按以下格式输出：",
    "<thinking>",
    "### 1. 问题理解",
    "- [用自己的话复述问题，确认理解正确]",
    "",
    "### 2. 关键信息",
    "- 已知条件 / 约束 / 目标",
    "",
    "### 3. 方案分析（至少2个备选）",
    "- 方案A：[描述] — 优点/缺点/复杂度/风险",
    "- 方案B：[描述] — 优点/缺点/复杂度/风险",
    "",
    "### 4. 方案选择与推导",
    "- 选择方案X，理由：[说明]",
    "- 逐步推导过程",
    "",
    "### 5. 验证与边界检查",
    "- [ ] 满足所有需求？",
    "- [ ] 边界条件 OK？",
    "</thinking>",
    "",
    "<answer>",
    "[最终答案]",
    "</answer>",
    "",
    "不可省略任何标签或子步骤。",
  ].join("\n"),
};

/**
 * 获取指定深度的思考提示词
 * @param {"quick"|"standard"|"deep"} depth
 * @returns {string}
 */
function getThinkingPrompt(depth = "standard") {
  return THINKING_SYSTEM_PROMPTS[depth] || THINKING_SYSTEM_PROMPTS.standard;
}

/**
 * 将思考提示词注入到 system 消息中
 * 复用已有 system prompt，追加思考规则
 *
 * @param {object} body - 请求体（Anthropic 或 OpenAI 格式）
 * @param {string} depth - 思考深度
 * @param {string} format - "anthropic" | "openai"
 * @returns {object} 修改后的请求体
 */
function injectThinkingPrompt(body, depth = "standard", format = "anthropic") {
  const thinkingPrompt = getThinkingPrompt(depth);
  const cloned = JSON.parse(JSON.stringify(body));

  if (format === "anthropic") {
    // Anthropic: system 是顶层字符串或数组
    if (!cloned.system) {
      cloned.system = thinkingPrompt;
    } else if (Array.isArray(cloned.system)) {
      cloned.system.push({ type: "text", text: "\n\n" + thinkingPrompt });
    } else if (typeof cloned.system === "string") {
      cloned.system = cloned.system + "\n\n" + thinkingPrompt;
    }

    // 双保险：在最后一条用户消息末尾追加格式提醒
    const msgs = cloned.messages || [];
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
        lastMsg.content =
          lastMsg.content +
          "\n\n（请严格按格式回复：先输出 <thinking>...</thinking> 标签包裹的推理过程，再输出 <answer>...</answer> 标签包裹的最终答案。不可省略标签。）";
      } else if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        // content 是数组格式，追加 text block
        lastMsg.content.push({
          type: "text",
          text: "\n\n（请严格按格式回复：先输出 <thinking>...</thinking> 标签包裹的推理过程，再输出 <answer>...</answer> 标签包裹的最终答案。不可省略标签。）",
        });
      }
    }
  } else {
    // OpenAI: system 在 messages 数组中
    const messages = cloned.messages || [];
    const systemIdx = messages.findIndex((m) => m.role === "system");
    if (systemIdx >= 0) {
      messages[systemIdx].content =
        messages[systemIdx].content + "\n\n" + thinkingPrompt;
    } else {
      messages.unshift({ role: "system", content: thinkingPrompt });
    }

    // 双保险：最后一条用户消息追加格式提醒
    if (messages.length > 0) {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      if (lastUserIdx >= 0) {
        messages[lastUserIdx].content =
          messages[lastUserIdx].content +
          "\n\n（请严格按格式回复：先输出 <thinking> 标签的推理，再输出 <answer> 标签的答案。）";
      }
    }
    cloned.messages = messages;
  }

  return cloned;
}

/**
 * 思考努力程度 → 提示词映射
 * effort 越高，要求在 thinking 块中推理越深入
 */
const EFFORT_TO_DEPTH = {
  low: "quick",
  medium: "standard",
  high: "deep",
  max: "deep",
};

/**
 * 根据 effort 值获取对应的思考深度
 * @param {"low"|"medium"|"high"|"max"} effort
 * @returns {string}
 */
function resolveDepth(effort) {
  return EFFORT_TO_DEPTH[effort] || "standard";
}

/**
 * 从请求体中提取 thinking 深度/effort 设置
 * 支持三层优先级：
 * 1. thinking.effort 参数（模拟原生 API 行为） → low/medium/high/max
 * 2. 用户消息前缀 [quick] / [standard] / [deep]
 * 3. 默认值
 *
 * @param {object} body - 请求体
 * @param {string} format - "anthropic" | "openai"
 * @returns {{depth: string, body: object}} 提取出的深度和清理后的请求体
 */
function extractDepthFromBody(body, format = "anthropic") {
  const cloned = JSON.parse(JSON.stringify(body));
  let depth = "standard";

  // 优先从 thinking.effort 参数读取（模拟原生 API）
  if (cloned.thinking && cloned.thinking.effort) {
    depth = resolveDepth(cloned.thinking.effort);
    return { depth, body: cloned };
  }

  // 其次从用户消息前缀读取
  const depthPrefixes = {
    quick: "[quick]",
    standard: "[standard]",
    deep: "[deep]",
  };

  if (format === "anthropic") {
    const msgs = cloned.messages || [];
    for (const msg of msgs) {
      for (const [d, prefix] of Object.entries(depthPrefixes)) {
        if (typeof msg.content === "string" && msg.content.startsWith(prefix)) {
          depth = d;
          msg.content = msg.content.replace(new RegExp("^\\" + prefix + "\\s*"), "");
          return { depth, body: cloned };
        }
      }
    }
  } else {
    const msgs = cloned.messages || [];
    for (const msg of msgs) {
      for (const [d, prefix] of Object.entries(depthPrefixes)) {
        if (typeof msg.content === "string" && msg.content.startsWith(prefix)) {
          depth = d;
          msg.content = msg.content.replace(new RegExp("^\\" + prefix + "\\s*"), "");
          return { depth, body: cloned };
        }
      }
    }
  }

  return { depth, body: cloned };
}

module.exports = {
  EFFORT_TO_DEPTH,
  resolveDepth,
  getThinkingPrompt,
  injectThinkingPrompt,
  extractDepthFromBody,
  THINKING_SYSTEM_PROMPTS,
};
