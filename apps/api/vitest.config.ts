// SPDX-License-Identifier: AGPL-3.0-or-later
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// esbuild can't emit decorator metadata, which Nest's dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
