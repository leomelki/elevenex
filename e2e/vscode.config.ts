import { defineConfig } from "@playwright/test";

// Run against preview servers started by the repository screenshot workflow.
// This suite never seeds/resets the user's application database.
export default defineConfig({
  testDir: "./tests",
  testMatch: "vscode-lifecycle.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: { channel: "chrome", headless: true, trace: "retain-on-failure" },
});
