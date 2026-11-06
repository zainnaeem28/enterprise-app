import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMigration, parseHeader, type Finding, type MigrationHeader } from './rules.js';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly sha256: string;
  readonly header: MigrationHeader;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export class MigrationError extends Error {
  constructor(
    readonly code:
      | 'BAD_FILENAME'
      | 'DUPLICATE_VERSION'
      | 'RULE_VIOLATION'
      | 'OUT_OF_ORDER'
      | 'MISSING_APPLIED'
      | 'CHANGED_APPLIED',
    message: string,
    readonly findings: readonly Finding[] = [],
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

const FILENAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Reads `NNNN_name.sql` files in version order. Anything else in the directory is an error. */
export function loadMigrations(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (file === '.gitkeep') continue;
    const m = FILENAME.exec(file);
    if (!m)
      throw new MigrationError(
        'BAD_FILENAME',
        `${file}: expected NNNN_name.sql (four-digit version, lower-case name)`,
      );
    const sql = readFileSync(join(dir, file), 'utf8');
    files.push({
      version: Number(m[1]),
      name: m[2]!,
      file,
      sql,
      sha256: sha256(sql),
      header: parseHeader(sql),
    });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new MigrationError(
        'DUPLICATE_VERSION',
        `${files[i]!.file} and ${files[i - 1]!.file} share version ${files[i]!.version}`,
      );
    }
  }
  return files;
}

/** Hash over every file's version, name and hash, in version order (compared with the image manifest). */
export function combinedHash(files: readonly MigrationFile[]): string {
  return sha256(files.map((f) => `${f.version}:${f.name}:${f.sha256}`).join('\n'));
}

/** Runs the statement rules on every file; throws with all findings, not just the first. */
export function assertRules(files: readonly MigrationFile[]): void {
  const findings: Finding[] = [];
  const labelled: string[] = [];
  for (const f of files) {
    for (const x of checkMigration(f.sql)) {
      findings.push(x);
      labelled.push(`${f.file} statement ${x.statement} [${x.rule}]: ${x.message}`);
    }
  }
  if (findings.length > 0)
    throw new MigrationError('RULE_VIOLATION', labelled.join('\n'), findings);
}

/**
 * Decides which files to apply. Throws instead of applying anything silently:
 * - an applied version that is no longer on disk, or whose content changed;
 * - a pending version numbered below the highest applied one (out of order).
 */
export function planPending(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const a of applied) {
    const f = byVersion.get(a.version);
    if (!f)
      throw new MigrationError(
        'MISSING_APPLIED',
        `Applied migration ${a.version}_${a.name} is not in the migration directory`,
      );
    if (f.sha256 !== a.sha256) {
      throw new MigrationError(
        'CHANGED_APPLIED',
        `Applied migration ${a.version}_${a.name} has changed since it was applied (hash mismatch)`,
      );
    }
  }
  const done = new Set(applied.map((a) => a.version));
  const pending = files.filter((f) => !done.has(f.version));
  const highest = applied.reduce((m, a) => Math.max(m, a.version), 0);
  const stale = pending.filter((f) => f.version < highest);
  if (stale.length > 0) {
    throw new MigrationError(
      'OUT_OF_ORDER',
      `Out-of-order migration${stale.length > 1 ? 's' : ''} ${stale.map((f) => f.file).join(', ')}: version is below the highest applied (${highest}). Renumber it above ${highest}.`,
    );
  }
  return pending;
}
