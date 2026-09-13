/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 本地开发：/api 与 /health 代理到 FastAPI（默认 8000，可用 API_PORT 覆盖）
const apiTarget = `http://localhost:${process.env.API_PORT ?? "8000"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["node_modules", "dist", "e2e/**"],
  },
});
