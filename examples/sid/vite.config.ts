import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5175,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm', '**/*.sid'],
  build: {
    assetsInlineLimit: 0,
  },
});
