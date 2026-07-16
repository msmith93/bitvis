import { defineConfig } from '@playwright/test'

// E2E smoke tests for the stepped close-ups. Playwright starts its own Vite dev
// server on a fixed port (reusing one if already running) and drives real
// Chromium — so a runtime error in any zoom fails the suite, which `npm run
// build` alone can't catch.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5183',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npx vite --port 5183 --strictPort',
    url: 'http://localhost:5183',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
