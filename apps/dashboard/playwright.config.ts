import { defineConfig } from '@playwright/test'

const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT ?? 5174)
const API_PORT = Number(process.env.E2E_API_PORT ?? 8790)
const MOCK_STRIPE_PORT = Number(process.env.MOCK_STRIPE_PORT ?? 8791)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'node e2e/mock-stripe.mjs',
      url: `http://127.0.0.1:${MOCK_STRIPE_PORT}/__health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: 'node e2e/start-api.mjs',
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `API_PROXY_TARGET=http://127.0.0.1:${API_PORT} pnpm exec vite --port ${DASHBOARD_PORT} --strictPort`,
      url: `http://localhost:${DASHBOARD_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
