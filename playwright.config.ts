import { defineConfig } from '@playwright/test'

const baseURL = process.env.IMPORT_WORKFLOW_TEST_URL || 'http://127.0.0.1:3009'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 240_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, headless: true },
  webServer: process.env.IMPORT_WORKFLOW_TEST_URL
    ? undefined
    : { command: 'pnpm start', url: `${baseURL}/api/health`, reuseExistingServer: true },
})
