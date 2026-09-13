import { defineConfig, devices } from "@playwright/test";

// 真实联调：浏览器访问由 docker compose 启动的 Web，经 Nginx/Vite 打到真实 API
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
    // 容器内 root 运行 Chromium 需要 --no-sandbox
    launchOptions: process.env.PLAYWRIGHT_NO_SANDBOX
      ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] }
      : {},
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
