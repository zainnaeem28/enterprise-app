// Proves the import-boundary rule rejects an upward import and accepts a downward one.
import { ESLint } from 'eslint';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import boundaries from './boundaries-plugin.mjs';

const root = path.resolve(import.meta.dirname, 'fixtures');
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    tseslint.configs.base,
    {
      files: ['**/*.ts'],
      plugins: { boundaries },
      rules: { 'boundaries/module-boundaries': 'error' },
    },
  ],
});

async function run(dir) {
  const results = await eslint.lintFiles([`${dir}/**/*.ts`]);
  return results.flatMap((r) =>
    r.messages.map((m) => ({
      file: path.relative(root, r.filePath),
      ruleId: m.ruleId,
      message: m.message,
    })),
  );
}

const bad = await run('boundary');
const ok = await run('boundary-ok');
console.log('failing fixture messages:', JSON.stringify(bad, null, 2));
console.log('passing fixture messages:', JSON.stringify(ok, null, 2));
const rejected =
  bad.length === 1 &&
  bad[0].ruleId === 'boundaries/module-boundaries' &&
  bad[0].file.endsWith('violation.ts');
if (!rejected || ok.length !== 0) {
  console.error('FAIL: boundary rule did not behave as required');
  process.exit(1);
}
console.log('PASS: upward import rejected, downward import accepted');
