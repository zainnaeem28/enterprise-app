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
    // QA automated suites (HEAAA-674). k6 scripts run in the k6 runtime, not Node, so its globals are declared here.
    files: ['tests/load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        open: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // QA suites import shared helpers per file; an unused helper import is a warning here, not a build break. Product code keeps the rule as an error.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    plugins: { boundaries },
    rules: { 'boundaries/module-boundaries': 'error' },
  },
);
