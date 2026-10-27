// SPDX-License-Identifier: AGPL-3.0-or-later
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { thirdPartyLicenses } from './build/third-party-licenses.js';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // React Aria ships its built-in strings ("Select all", "Previous month") in 34 languages. The
    // interface is English for now, so keep only English. Dates, numbers, and money
    // are still formatted in the viewer's language by the browser's Intl APIs.
    { ...optimizeLocales.vite({ locales: ['en-US'] }), enforce: 'pre' },
    thirdPartyLicenses(),
  ],
  server: {
    port: 5173,
    // Same-origin API in development, so session cookies work exactly as in production.
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3000' },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    // A component test clicking through a dialog takes well under a second here, but can take
    // over 5 on a busy CI runner (PlaidKeysCard on #449). Hangs still fail, just later.
    testTimeout: 20_000,
  },
});
