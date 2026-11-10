import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import boundaries from './eslint/boundaries-plugin.mjs';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'docs/**', 'eslint/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // CloudWatch Synthetics canary: CommonJS Lambda source running on Node.
    files: ['infra/modules/observability/canary/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    plugins: { boundaries },
    rules: { 'boundaries/module-boundaries': 'error' },
  },
);
