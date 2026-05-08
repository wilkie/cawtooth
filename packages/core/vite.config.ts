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

// Worklet builds: each processor is a single self-contained ESM file —
// AudioWorkletGlobalScope has no module loader we can rely on, so nothing
// may stay external. We emit one bundle per chip family.
function workletConfig(entry: string, outFile: string): UserConfig {
  return {
    build: {
      outDir: 'dist/worklet',
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      sourcemap: true,
      minify: false,
      lib: {
        entry,
        formats: ['es'],
        fileName: () => outFile,
      },
      rollupOptions: {
        external: [],
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
}

const oplWorkletConfig = workletConfig('src/worklet/opl-processor.ts', 'opl-processor.js');
const sidWorkletConfig = workletConfig('src/worklet/sid-processor.ts', 'sid-processor.js');
const psidWorkletConfig = workletConfig('src/worklet/psid-processor.ts', 'psid-processor.js');
const ayWorkletConfig = workletConfig('src/worklet/ay-processor.ts', 'ay-processor.js');
const sndhWorkletConfig = workletConfig('src/worklet/sndh-processor.ts', 'sndh-processor.js');

export default defineConfig(({ mode }) => {
  if (mode === 'worklet') return oplWorkletConfig;
  if (mode === 'worklet-sid') return sidWorkletConfig;
  if (mode === 'worklet-psid') return psidWorkletConfig;
  if (mode === 'worklet-ay') return ayWorkletConfig;
  if (mode === 'worklet-sndh') return sndhWorkletConfig;
  return libConfig;
});
