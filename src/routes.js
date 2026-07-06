/**
 * 路由模块
 * 定义所有 API 端点，支持流式与非流式
 */

const express = require("express");
const config = require("./config");
const { proxyAnthropic, proxyOpenAI } = require("./proxy");
const { parseResponse, hideThinking } = require("./parser");

const router = express.Router();

// ========== 模型列表 ==========

router.get("/v1/models", async (req, res) => {
  try {
    const response = await fetch(`${config.UPSTREAM_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${config.UPSTREAM_API_KEY}`,
      },
    });
    const data = await response.json();
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

router.get("/models", (req, res) => {
  res.json({
    models: config.listModels(),
    thinking_types: config.THINKING_TYPES,
    default_depth: config.DEFAULT_THINKING_DEPTH,
  });
});

// ========== Anthropic 格式 ==========

router.post("/v1/messages", async (req, res) => {
  try {
    const result = await proxyAnthropic(req.body, req.headers, res);
    // 仅非流式才会返回 result 对象；流式时 res 已被接管
    if (result) {
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    if (!res.headersSent) {
      console.error("[error] /v1/messages:", err.message);
      res.status(502).json({ error: "代理转发失败", detail: err.message });
    }
  }
});

// ========== OpenAI 格式 ==========

router.post("/v1/chat/completions", async (req, res) => {
  try {
    const result = await proxyOpenAI(req.body, req.headers, res);
    if (result) {
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    if (!res.headersSent) {
      console.error("[error] /v1/chat/completions:", err.message);
      res.status(502).json({ error: "代理转发失败", detail: err.message });
    }
  }
});

// ========== 工具端点 ==========

router.post("/parse", (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "缺少 text 字段" });
  }
  res.json(parseResponse(text));
});

router.post("/hide-thinking", (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "缺少 text 字段" });
  }
  res.json({ answer: hideThinking(text) });
});

// ========== 健康检查 ==========

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    upstream: config.UPSTREAM_BASE_URL,
    parse_thinking: config.PARSE_THINKING_RESPONSE,
    default_depth: config.DEFAULT_THINKING_DEPTH,
  });
});

module.exports = router;
