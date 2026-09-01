import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

import {
  BACKEND_PORT,
  DB_PATH,
  FRONTEND_PORT,
  prepareE2eEnvironment,
} from './fixtures/environment';

// Reset the database + seed the test repo before either dev server boots.
prepareE2eEnvironment();

const repoRoot = path.resolve(__dirname, '..');
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests',
  // The flow is a single long happy path; keep it serial and deterministic.
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: isCI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The desktop shell is driven through Electron, not a browser context.
      testIgnore: /multi-window\.spec\.ts/,
    },
    {
      // Multi-window behaviour only exists in the desktop shell, which is
      // launched against the same dev servers rather than a packaged build.
      name: 'electron',
      testMatch: /multi-window\.spec\.ts/,
      dependencies: ['chromium'],
    },
  ],
  webServer: [
    {
      // NestJS backend (sqlite + git). Watch mode keeps the process alive.
      command: 'pnpm --dir apps/backend start:dev',
      cwd: repoRoot,
      url: `http://127.0.0.1:${BACKEND_PORT}/api/info`,
      timeout: 300_000,
      reuseExistingServer: !isCI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DB_PATH,
        ELEVENEX_PROXY_PORT: String(BACKEND_PORT),
      },
    },
    {
      // Angular dev server; proxies /api + websockets to the backend.
      command: 'pnpm --dir apps/frontend start',
      cwd: repoRoot,
      url: `http://127.0.0.1:${FRONTEND_PORT}`,
      timeout: 300_000,
      reuseExistingServer: !isCI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
