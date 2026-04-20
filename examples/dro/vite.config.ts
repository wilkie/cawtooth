import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5175,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    // Keep the worklet as a real file asset (see examples/tone for rationale).
    assetsInlineLimit: 0,
  },
});
