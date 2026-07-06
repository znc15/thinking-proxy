/**
 * 入口文件
 * 启动代理服务器
 */

require("dotenv").config();

const express = require("express");
const config = require("./config");
const routes = require("./routes");

const app = express();

// 解析 JSON 请求体（最大 10MB，适配大 context）
app.use(express.json({ limit: "10mb" }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// 挂载路由
app.use("/", routes);

// 启动
const { PORT } = config;

app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   🧠 Thinking Proxy Server              ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║   地址 : http://localhost:${PORT}            ║`);
  console.log(`║   上游 : ${config.UPSTREAM_BASE_URL}     ║`);
  console.log(`║   解析 : ${config.PARSE_THINKING_RESPONSE ? "开启" : "关闭"}                          ║`);
  console.log(`║   深度 : ${config.DEFAULT_THINKING_DEPTH}                      ║`);
  console.log("╠══════════════════════════════════════════╣");
  console.log("║   端点:                                   ║");
  console.log("║   POST /v1/messages         (Anthropic) ║");
  console.log("║   POST /v1/chat/completions (OpenAI)    ║");
  console.log("║   GET  /v1/models           模型列表    ║");
  console.log("║   GET  /models              模型配置    ║");
  console.log("║   POST /parse               解析回复    ║");
  console.log("║   POST /hide-thinking       隐藏思考    ║");
  console.log("║   GET  /health              健康检查    ║");
  console.log("╚══════════════════════════════════════════╝");

  console.log("\n支持模型及 thinking 模式:");
  const models = config.listModels();
  const icon = {
    native: "🔵 原生",
    prompt: "🟡 提示词模拟",
    none: "⚪ 不适用",
  };
  for (const m of models) {
    console.log(`  ${icon[m.thinking] || "  "}  ${m.id}`);
  }
});
