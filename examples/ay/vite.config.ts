import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5182,
    strictPort: false,
  },
  assetsInclude: ['**/*.wasm', '**/*.psg', '**/*.vtx', '**/*.ym'],
  build: {
    assetsInlineLimit: 0,
  },
});
