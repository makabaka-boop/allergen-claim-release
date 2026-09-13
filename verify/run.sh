#!/usr/bin/env bash
# 一次性验收：任一环节失败即整体失败（set -e）
set -euo pipefail

echo "==> [1/4] 后端 pytest（Python 3.12，裁决规则与 422 字段级错误）"
cd /app/api
python --version
python -m pytest -q

echo "==> [2/4] 前端 TypeScript 类型检查与生产构建"
cd /app/web
npm run build

echo "==> [3/4] 前端 Vitest 组件/状态流测试"
npx vitest run

echo "==> [4/4] Playwright 端到端：浏览器 -> Web -> 真实 FastAPI"
# E2E_BASE_URL 由 compose 注入（http://web），指向同栈真实服务
npx playwright test

echo "==> 验收全部通过"
