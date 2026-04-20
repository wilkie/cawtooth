import { defineConfig, type UserConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Library build: main entry as dual ESM + CJS with rolled-up type declarations.
const libConfig: UserConfig = {
  plugins: [
    // Emit one .d.ts per source file. Rolling up into a single bundle
    // (rollupTypes: true) was dropping declarations for types that are
    // only re-exported from index.ts — per-file emission keeps all paths
    // resolvable without the rollup pass trying to be clever.
    dts({
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
      insertTypesEntry: false,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'cjs' ? 'index.cjs' : 'index.js'),
    },
    rollupOptions: {
      // No runtime deps today; keep externals explicit so nothing slips in.
      external: [],
    },
  },
};

// Worklet build: single self-contained ESM file. AudioWorkletGlobalScope has
// no module loader we can rely on, so nothing may stay external.
const workletConfig: UserConfig = {
  build: {
    outDir: 'dist/worklet',
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/worklet/opl-processor.ts',
      formats: ['es'],
      fileName: () => 'opl-processor.js',
    },
    rollupOptions: {
      external: [],
      output: {
        inlineDynamicImports: true,
      },
    },
  },
};

export default defineConfig(({ mode }) => (mode === 'worklet' ? workletConfig : libConfig));
