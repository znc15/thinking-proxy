/**
 * 路由模块
 * 定义所有 API 端点
 */

const express = require("express");
const config = require("./config");
const { proxyAnthropic, proxyOpenAI } = require("./proxy");
const { parseResponse, hideThinking } = require("./parser");

const router = express.Router();

// ========== 模型列表 ==========

/** GET /v1/models — 获取支持的模型列表（透传上游） */
router.get("/v1/models", async (req, res) => {
  try {
    const response = await fetch(`${config.UPSTREAM_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${config.UPSTREAM_API_KEY}`,
      },
    });
    const data = await response.json();
    // 注入 thinking 支持信息
    if (data.data) {
      data.data = data.data.map((m) => ({
        ...m,
        thinking_support: config.getModelConfig(m.id).thinking,
      }));
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "获取模型列表失败", detail: err.message });
  }
});

/** GET /models — 本地模型配置信息 */
router.get("/models", (req, res) => {
  res.json({
    models: config.listModels(),
    thinking_types: config.THINKING_TYPES,
    default_depth: config.DEFAULT_THINKING_DEPTH,
  });
});

// ========== Anthropic 格式 ==========

/** POST /v1/messages — Anthropic Messages API */
router.post("/v1/messages", async (req, res) => {
  try {
    const result = await proxyAnthropic(req.body, req.headers);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[error] /v1/messages:", err.message);
    res.status(502).json({ error: "代理转发失败", detail: err.message });
  }
});

// ========== OpenAI 格式 ==========

/** POST /v1/chat/completions — OpenAI Chat Completions API */
router.post("/v1/chat/completions", async (req, res) => {
  try {
    const result = await proxyOpenAI(req.body, req.headers);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[error] /v1/chat/completions:", err.message);
    res.status(502).json({ error: "代理转发失败", detail: err.message });
  }
});

// ========== 工具端点 ==========

/** POST /parse — 解析一段文本中的 thinking/answer 标签 */
router.post("/parse", (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "缺少 text 字段" });
  }
  res.json(parseResponse(text));
});

/** POST /hide-thinking — 从文本中移除 thinking 块 */
router.post("/hide-thinking", (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "缺少 text 字段" });
  }
  res.json({ answer: hideThinking(text) });
});

// ========== 健康检查 ==========

/** GET /health */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    upstream: config.UPSTREAM_BASE_URL,
    parse_thinking: config.PARSE_THINKING_RESPONSE,
    default_depth: config.DEFAULT_THINKING_DEPTH,
  });
});

module.exports = router;
