// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run against a real Postgres: quick here, but over vitest's 5 s default on a busy CI
    // runner (backup.test.ts on #451). A hang still fails, just later.
    testTimeout: 20_000,
  },
});
