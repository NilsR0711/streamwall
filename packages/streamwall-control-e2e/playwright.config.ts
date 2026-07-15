import { defineConfig, devices } from '@playwright/test'

// Each test boots its own control server + fake Streamwall uplink on a fresh
// ephemeral port (see tests/harness.ts), so there is no shared `webServer` or
// global `baseURL` here — tests navigate to the per-harness URL directly.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: false,
  // Serial: every test spins up a real Fastify server + WebSocket uplink, and
  // the handful of smoke tests are cheap enough that one worker keeps them
  // deterministic (no port-allocation races, no resource contention).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
