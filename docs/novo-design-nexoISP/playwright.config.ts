import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "/tmp/nexo-playwright-results",
  use: { baseURL: "http://localhost:3000", browserName: "chromium", viewport: { width: 1342, height: 805 }, colorScheme: "dark", trace: "retain-on-failure" },
  webServer: { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 60_000 },
});
