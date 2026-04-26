import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5181,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    // Worklets must remain real file assets — see other example vite configs.
    assetsInlineLimit: 0,
  },
});
