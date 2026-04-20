import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5176,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    assetsInlineLimit: 0,
  },
});
