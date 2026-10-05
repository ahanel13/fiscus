import optimizeLocales from '@react-aria/optimize-locales-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // React Aria ships its built-in strings ("Select all", "Previous month") in 34 languages. The
    // interface is English for now, so keep only English. Dates, numbers, and money
    // are still formatted in the viewer's language by the browser's Intl APIs.
    { ...optimizeLocales.vite({ locales: ['en-US'] }), enforce: 'pre' },
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
  },
});
