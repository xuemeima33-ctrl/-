import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3099", channel: "chrome", headless: true },
  webServer: {
    command: "DEMO_MODE=1 PORT=3099 DB_PATH=:memory: npm start",
    url: "http://127.0.0.1:3099",
    reuseExistingServer: false,
  },
  reporter: "list",
});
