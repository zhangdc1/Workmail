import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser", workers: 1,
  use: { baseURL: "http://localhost:5173", viewport: { width: 1512, height: 982 }, channel: "chrome" },
  reporter: "list",
});
