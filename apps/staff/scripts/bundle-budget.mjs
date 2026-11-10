// Fails when the gzipped JS of the built staff app exceeds a budget. Thin wrapper: the logic (initial set, largest lazy
// chunk, total tripwire; limits and their raise rules in HEAAA-604 D-4/D-6) lives in tests/e2e/smoke/bundle-gzip.mjs,
// the file CI runs, so the local script and CI cannot drift.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('../../../tests/e2e/smoke/bundle-gzip.mjs', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const r = spawnSync(process.execPath, [shared, dist], { stdio: 'inherit' });
process.exit(r.status ?? 1);
