// Read-only SQL for the post-run reconciliations. The connection string (LOADTEST_RO_DATABASE_URL) is injected by the environment
// (in-VPC generator task); it is never in this repository and the role must be read-only. Refuses anything but SELECT.
import { execFileSync } from 'node:child_process';
export function query(sql) {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql))
    throw new Error('only a single SELECT is allowed');
  const url = process.env.LOADTEST_RO_DATABASE_URL;
  if (!url)
    throw new Error(
      'LOADTEST_RO_DATABASE_URL is required (read-only role on the loadtest database).',
    );
  const out = execFileSync(
    'psql',
    [
      url,
      '-X',
      '-A',
      '-t',
      '-F',
      '\t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SET default_transaction_read_only = on; ${sql}`,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((l) => l && l !== 'SET')
    .map((l) => l.split('\t'));
}
