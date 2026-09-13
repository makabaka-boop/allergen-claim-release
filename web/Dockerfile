# 构建阶段
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# 仅安装构建所需依赖（不执行 Playwright 下载脚本，验收浏览器在 verify 镜像中提供）
RUN npm ci --no-audit --no-fund --ignore-scripts || npm install --no-audit --no-fund --ignore-scripts
COPY tsconfig.json vite.config.ts vitest.setup.ts index.html ./
COPY src ./src
RUN npm run build

# 运行阶段：Nginx 同源反代 /api 到 API 容器
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
