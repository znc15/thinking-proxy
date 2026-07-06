/**
 * 提示词管理模块
 * 为不支持原生 thinking 的模型生成模拟思考的 system prompt
 */

const THINKING_SYSTEM_PROMPTS = {
  quick: [
    "【系统级规则】",
    "你的回复将以纯文本被程序解析。程序只识别 <thinking> 和 <answer> 标签。",
    "",
    "格式（必须严格遵守）：",
    "<thinking>1-3句简明推理</thinking>",
    "<answer>最终回答</answer>",
    "",
    "禁止事项：",
    "- 禁止在标签外输出任何文字",
    "- 禁止在回复中使用 emoji 表情符号",
    "- 禁止省略 <thinking> 或 <answer> 标签",
  ].join("\n"),

  standard: [
    "===== 协议 v3 =====",
    "系统将你的输出解析为结构化数据。你必须严格按照以下格式回复，无一例外。",
    "",
    "【输出格式】",
    "<thinking>",
    "推理过程（问题理解→关键信息→方案分析→推导→验证）",
    "</thinking>",
    "<answer>",
    "最终答案（纯文本，不使用任何 emoji 表情符号）",
    "</answer>",
    "",
    "【绝对禁止】",
    "1. 禁止在 <thinking> 或 <answer> 标签之外输出任何文字",
    "2. 禁止在回复的任何位置使用 emoji（如 😊👍✅❌🎉💡 等）",
    "3. 禁止省略任何一个标签",
    "4. 禁止用「好的」、「明白了」等寒暄开头——直接输出 <thinking>",
    "",
    "【示例】",
    "用户：1+1=?",
    "<thinking>",
    "整数加法，1个单位加1个单位等于2。",
    "</thinking>",
    "<answer>",
    "1+1=2",
    "</answer>",
    "",
    "现在开始。记住：不寒暄、不用表情、直接输出标签。",
  ].join("\n"),

  deep: [
    "===== 协议 v3（深度推理） =====",
    "系统将你的输出解析为结构化数据。你必须严格按照以下格式回复。",
    "",
    "【输出格式】",
    "<thinking>",
    "### 1. 问题理解",
    "- 用自己的话复述，确认理解正确",
    "### 2. 关键信息",
    "- 已知条件、约束、目标",
    "### 3. 方案分析（至少2个备选，对比优劣）",
    "### 4. 方案选择与推导",
    "### 5. 验证与边界检查",
    "</thinking>",
    "<answer>",
    "最终答案（纯文本，不使用任何 emoji 表情符号）",
    "</answer>",
    "",
    "【绝对禁止】",
    "1. 标签之外不能有任何文字",
    "2. 整个回复不能出现任何 emoji",
    "3. 禁止寒暄——直接输出 <thinking> 开头的内容",
    "4. 标签不能变形或省略",
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

    // 双保险：用户消息末尾追加简短格式提醒
    const msgs = cloned.messages || [];
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      const hint = "\n\n（直接回复 <thinking>...</thinking><answer>...</answer>，不寒暄不用表情）";
      if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
        lastMsg.content = lastMsg.content + hint;
      } else if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        lastMsg.content.push({ type: "text", text: hint });
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
          "\n\n（直接回复 <thinking>...</thinking><answer>...</answer>，不寒暄不用表情）";
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
