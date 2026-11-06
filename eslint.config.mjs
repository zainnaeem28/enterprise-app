import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import boundaries from './eslint/boundaries-plugin.mjs';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', 'eslint/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    plugins: { boundaries },
    rules: { 'boundaries/module-boundaries': 'error' },
  },
);
