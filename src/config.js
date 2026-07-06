/**
 * 配置加载模块
 * 加载模型能力配置、环境变量、思考级别映射
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config();

// 模型能力配置
const modelConfigPath = path.join(__dirname, "..", "config.json");
const modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, "utf-8"));

/**
 * thinking 类型说明：
 * - "native"  : 模型原生支持 Extended Thinking，透传 thinking 参数
 * - "prompt"  : 模型不支持原生 thinking，使用提示词模拟
 * - "none"    : 不涉及 thinking（如非 Claude 模型），不做任何处理
 */
const THINKING_TYPES = {
  NATIVE: "native",
  PROMPT: "prompt",
  NONE: "none",
};

/** 获取模型配置 */
function getModelConfig(modelId) {
  const cfg = modelConfig.models[modelId];
  if (!cfg) {
    // 未知模型：默认走 prompt 模拟（安全策略）
    return { thinking: THINKING_TYPES.PROMPT, label: modelId };
  }
  return cfg;
}

/** 检查模型是否支持原生 thinking */
function supportsNativeThinking(modelId) {
  return getModelConfig(modelId).thinking === THINKING_TYPES.NATIVE;
}

/** 检查模型是否需要提示词模拟 */
function needsPromptThinking(modelId) {
  return getModelConfig(modelId).thinking === THINKING_TYPES.PROMPT;
}

/** 列出所有模型及 thinking 支持状态 */
function listModels() {
  return Object.entries(modelConfig.models).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    thinking: cfg.thinking,
  }));
}

module.exports = {
  THINKING_TYPES,
  getModelConfig,
  supportsNativeThinking,
  needsPromptThinking,
  listModels,
  // 环境变量
  PORT: process.env.PORT || 19901,
  UPSTREAM_BASE_URL: process.env.UPSTREAM_BASE_URL || "https://your-upstream-api.example.com",
  UPSTREAM_API_KEY: process.env.UPSTREAM_API_KEY || "",
  DEFAULT_THINKING_DEPTH: process.env.DEFAULT_THINKING_DEPTH || "standard",
  PARSE_THINKING_RESPONSE: process.env.PARSE_THINKING_RESPONSE !== "false",
};
