// Executable entry for the static checks (38.2 item 4, 21.3):
//   node dist/scope/check-static.js [--signin-allow <path-fragment>]... [--skip <path-fragment>]... <dir-or-file>...
// --skip drops the file that defines the owner-function list itself (with-scope.ts).
// Scans .ts files (tests and declaration files excluded), prints `file:line rule message` per violation and exits 1
// if there is any; exits 2 on usage errors. Wired as `pnpm --filter @ehr/kernel check:static` over the kernel and API source.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkLockOrder, checkSignInCallSites, type Violation } from './lock-order-check.js';

const SKIP = /(\.test\.ts|\.dbtest\.ts|\.d\.ts)$/;

export function collect(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith('.ts') && !SKIP.test(e.name)) out.push(p);
  }
  return out.sort();
}

export function runStaticChecks(
  paths: string[],
  signinAllow: string[],
  skip: string[] = [],
): Violation[] {
  const v: Violation[] = [];
  for (const root of paths)
    for (const file of collect(root)) {
      if (skip.some((x) => file.includes(x))) continue;
      const src = readFileSync(file, 'utf8');
      v.push(...checkLockOrder(file, src));
      v.push(...checkSignInCallSites(file, src, (f) => signinAllow.some((a) => f.includes(a))));
    }
  return v;
}

function main(argv: string[]): number {
  const paths: string[] = [];
  const allow: string[] = [];
  const skip: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--signin-allow' && argv[i + 1] !== undefined) allow.push(argv[++i]!);
    else if (argv[i] === '--skip' && argv[i + 1] !== undefined) skip.push(argv[++i]!);
    else paths.push(argv[i]!);
  }
  if (paths.length === 0) {
    console.error(
      'usage: check-static [--signin-allow <fragment>]... [--skip <fragment>]... <dir-or-file>...',
    );
    return 2;
  }
  const v = runStaticChecks(paths, allow, skip);
  for (const x of v) console.error(`${x.file}:${x.line} ${x.rule} ${x.message}`);
  console.error(v.length === 0 ? 'static checks: ok' : `static checks: ${v.length} violation(s)`);
  return v.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  process.exit(main(process.argv.slice(2)));
