import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
  ssr: {
    resolve: {
      // Vitest's default node environment uses Vite's ssr environment, so SSR
      // conditions are what govern subpath-imports resolution.
      // `require` is listed first so packages with mismatched ESM/CJS exports
      // (e.g. `ws`'s wrapper.mjs which omits `.Server`) load via their CJS
      // entry, matching how mockttp's transitives expect them.
      conditions: ['@aurica/source', 'require', 'default'],
    },
  },
});
