import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
  prettier,
);
