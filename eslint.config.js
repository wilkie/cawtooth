import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      'tools/emsdk/',
      'tools/nuked-opl3/',
      'packages/core/native/',
      'packages/core/wasm/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node-executed tools and configs.
  {
    files: ['tools/**/*.{js,mjs,cjs}', '**/*.config.{js,mjs,cjs,ts}', '**/jest.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
