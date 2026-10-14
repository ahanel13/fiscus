// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// Screenshots for the walkthroughs in docs/design/walkthroughs/. Runs against a FRESH stack, like
// the e2e journey: E2E_BASE_URL and E2E_SETUP_TOKEN. `pnpm --filter @fiscus/web walkthrough`.
export default defineConfig({
  testDir: 'walkthrough',
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
