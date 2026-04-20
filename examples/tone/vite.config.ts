import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
  },
  // Keep the wasm served with its proper MIME type and not transformed.
  assetsInclude: ['**/*.wasm'],
  build: {
    // Never inline assets as base64 data URLs. The worklet script must be
    // a real file for audioWorklet.addModule() to accept it — data URLs
    // trip CSP and cross-origin checks in browsers.
    assetsInlineLimit: 0,
  },
});
