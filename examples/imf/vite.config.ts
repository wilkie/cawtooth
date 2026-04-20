import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    // See examples/tone/vite.config.ts for rationale — data URLs break
    // audioWorklet.addModule() in browsers with strict CSP / cross-origin
    // checks. Keep the worklet as a real file asset.
    assetsInlineLimit: 0,
  },
});
