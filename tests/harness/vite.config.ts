import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  server: {
    port: 5190,
    strictPort: true,
  },
  // Worklets must be served as real assets — see other example vite configs.
  build: {
    assetsInlineLimit: 0,
  },
  assetsInclude: ['**/*.wasm', '**/*.sid', '**/*.imf'],
});
