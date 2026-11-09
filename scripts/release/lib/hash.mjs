// Hashing helpers shared by the release scripts. A "listing hash" is the sha256 of the sorted lines
// "<sha256>  <relative path>\n" of every file under a directory, so it is independent of file order and mtimes.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const sha256File = (path) => sha256(readFileSync(path));

export function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Sorted `{path, sha256}` entries for every file under dir (POSIX-style relative paths). */
export function listing(dir) {
  return walk(dir)
    .map((p) => ({ path: relative(dir, p).split(sep).join('/'), sha256: sha256File(p) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const listingHash = (entries) =>
  sha256(entries.map((e) => `${e.sha256}  ${e.path}\n`).join(''));
