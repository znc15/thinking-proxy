# ========== 基础镜像 ==========
FROM node:22-alpine AS builder

WORKDIR /app

# 利用 Docker 缓存层，先复制依赖文件
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ========== 运行镜像 ==========
FROM node:22-alpine

# 创建非 root 用户
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# 从 builder 复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制源码
COPY src/ ./src/
COPY config.json ./

# 切换到非 root 用户
USER app

# 暴露端口
EXPOSE 19901

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:19901/health || exit 1

# 启动
CMD ["node", "src/index.js"]
