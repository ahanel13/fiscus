// SPDX-License-Identifier: AGPL-3.0-or-later
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild can't emit decorator metadata, which Nest's dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    // Each test talks to a real Postgres: well under a second here, but over vitest's 5 s
    // default on a busy CI runner ([TXN-08/MEM] on #451). A hang still fails, just later.
    testTimeout: 20_000,
  },
});
