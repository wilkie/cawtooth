import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    strictPort: false,
  },
  // Treat any chiptune extension as an asset so `?url` imports work.
  assetsInclude: ['**/*.wasm', '**/*.sid', '**/*.imf', '**/*.wlf', '**/*.dro', '**/*.hsq'],
  build: {
    // Worklets must remain real file assets — see other examples for context.
    assetsInlineLimit: 0,
  },
});
