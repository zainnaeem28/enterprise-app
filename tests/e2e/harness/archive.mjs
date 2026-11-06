// Trace archive: tar.gz of the Playwright output directory plus a sha256 for the manifest. Uses the system `tar`
// (present on the CI runner image); a missing tool or an empty directory is an error, never a silent skip.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

export function archiveDir(dir, outFile) {
  const files = listFiles(dir);
  if (files.length === 0)
    throw new Error(`no trace output in ${dir}: nothing to archive (tracing must be on)`);
  // Fixed order and numeric owner keep the archive reproducible for the same input bytes.
  execFileSync('tar', [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    outFile,
    '-C',
    dirname(dir),
    basename(dir),
  ]);
  const size = statSync(outFile).size;
  if (size === 0) throw new Error(`archive ${outFile} is empty`);
  return {
    file: outFile,
    files: files.length,
    traceZips: files.filter((f) => f.endsWith('trace.zip')).length,
    bytes: size,
    sha256: createHash('sha256').update(readFileSync(outFile)).digest('hex'),
  };
}
