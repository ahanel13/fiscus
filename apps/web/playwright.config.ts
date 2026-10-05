// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// Runs against a running stack (docker compose in CI): E2E_BASE_URL and E2E_SETUP_TOKEN.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  // The journey runs against one fresh instance, so a retry can't repeat first-run setup.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
