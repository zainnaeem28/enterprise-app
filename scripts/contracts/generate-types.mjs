// Generates packages/contracts/src/generated/openapi.ts from the root index with openapi-typescript.
// `--check` generates to packages/contracts/dist/contract-reports/ and fails if the committed file differs (stale types).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractsDir, openapiDir, outDir, repoRoot } from './deps.mjs';

const bin = join(contractsDir, 'node_modules/.bin/openapi-typescript');
const committed = join(contractsDir, 'src/generated/openapi.ts');
const check = process.argv.includes('--check');
const target = check ? join(outDir, 'openapi.generated.ts') : committed;
mkdirSync(outDir, { recursive: true });
mkdirSync(join(contractsDir, 'src/generated'), { recursive: true });

const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
const run = spawnSync(bin, [join(openapiDir, 'openapi.yaml'), '-o', target], { encoding: 'utf8' });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.status !== 0) process.exit(run.status ?? 1);
// The generated file is formatted with the repository's Prettier configuration and carries a
// header, so the repository-wide `format:check` accepts it.
const prettier = join(repoRoot, 'node_modules/.bin/prettier');
// An empty ignore file, so the check copy under dist/ is formatted the same way as the committed one.
const noIgnore = join(outDir, 'empty.prettierignore');
writeFileSync(noIgnore, '');
const fmt = spawnSync(prettier, ['--ignore-path', noIgnore, '--write', target], {
  encoding: 'utf8',
  cwd: repoRoot,
});
if (fmt.status !== 0) {
  process.stderr.write(fmt.stdout + fmt.stderr);
  process.exit(fmt.status ?? 1);
}
console.log(`openapi-typescript ${version}`);
if (check) {
  if (readFileSync(target, 'utf8') !== readFileSync(committed, 'utf8')) {
    console.error('generated types are out of date: run pnpm --filter @ehr/contracts generate');
    process.exit(1);
  }
  console.log('generated types are up to date');
}
