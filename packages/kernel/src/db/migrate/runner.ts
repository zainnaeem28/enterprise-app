import {
  assertRules,
  loadMigrations,
  planPending,
  type AppliedMigration,
  type MigrationFile,
} from './plan.js';
import { splitStatements } from './sql-scan.js';

/** The only database surface the runner needs. A `pg` client satisfies it. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrateOptions {
  readonly dir: string;
  /** Plan and check only; apply nothing. */
  readonly dryRun?: boolean;
  /** `SET LOCAL lock_timeout` per migration (DEVOPS-PLAN 8.1 rule 6). */
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface MigrateResult {
  readonly applied: string[];
  readonly pending: string[];
}

/** Arbitrary constant: serialises concurrent runners on one database. */
const LOCK_KEY = 7_424_001;

const TRACKER_DDL = `
CREATE SCHEMA IF NOT EXISTS migration;
CREATE TABLE IF NOT EXISTS migration.schema_migration (
  version    integer PRIMARY KEY CHECK (version BETWEEN 1 AND 9999),
  name       text NOT NULL,
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by name NOT NULL DEFAULT current_user
);
REVOKE ALL ON SCHEMA migration FROM PUBLIC;
REVOKE ALL ON migration.schema_migration FROM PUBLIC;
`;

async function readApplied(db: SqlClient): Promise<AppliedMigration[]> {
  const r = await db.query(
    'SELECT version, name, sha256 FROM migration.schema_migration ORDER BY version',
  );
  return r.rows.map((x) => ({
    version: Number(x['version']),
    name: String(x['name']),
    sha256: String(x['sha256']),
  }));
}

/**
 * ARCHITECTURE 21.2 point 5 (A-3): before a file commits, the session is back on its login role and the temporary
 * merge-guard grant to app_owner is gone (the owner's own implicit privilege, before migration 0704 moves the function, is not a grant). Either failure rolls the file back.
 */
export async function assertOwnerStepsClosed(db: SqlClient): Promise<void> {
  const r = await db.query(
    `SELECT current_user::text AS cu, session_user::text AS su,
       EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
               JOIN pg_roles r ON r.oid = a.grantee
               WHERE p.oid = to_regprocedure('patient.guard_open_patient()') AND r.rolname = 'app_owner' AND a.grantee <> p.proowner) AS granted`,
  );
  const row = r.rows[0] ?? {};
  if (row['cu'] !== row['su'])
    throw new Error(
      `owner step left the session on role ${String(row['cu'])}, not ${String(row['su'])}`,
    );
  if (row['granted'] === true)
    throw new Error(
      'app_owner still holds EXECUTE on patient.guard_open_patient() (owner step not revoked)',
    );
}

async function apply(db: SqlClient, f: MigrationFile, opts: MigrateOptions): Promise<void> {
  const lock = Math.trunc(opts.lockTimeoutMs ?? 5_000);
  const stmt = Math.trunc(opts.statementTimeoutMs ?? 60_000);
  const record = (): Promise<unknown> =>
    db.query('INSERT INTO migration.schema_migration (version, name, sha256) VALUES ($1, $2, $3)', [
      f.version,
      f.name,
      f.sha256,
    ]);

  if (f.header.transaction === 'none') {
    // Statements that cannot run inside a transaction (CREATE INDEX CONCURRENTLY).
    await db.query(`SET lock_timeout = ${lock}; SET statement_timeout = ${stmt}`);
    try {
      for (const s of splitStatements(f.sql)) await db.query(s.text);
      await record();
    } finally {
      await db.query('RESET lock_timeout; RESET statement_timeout');
    }
    return;
  }

  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL lock_timeout = ${lock}; SET LOCAL statement_timeout = ${stmt}`);
    await db.query(f.sql);
    await assertOwnerStepsClosed(db);
    await record();
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

/**
 * Applies pending migrations in version order, each in its own transaction with
 * its tracker row. Rejects, before applying anything, a rule violation, a
 * changed or missing applied file, and an out-of-order version.
 */
export async function migrate(db: SqlClient, opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const files = loadMigrations(opts.dir);
  assertRules(files);

  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await db.query(TRACKER_DDL);
    const pending = planPending(files, await readApplied(db));
    const result = { applied: [] as string[], pending: pending.map((f) => f.file) };
    if (opts.dryRun) return result;
    for (const f of pending) {
      log(`applying ${f.file}`);
      await apply(db, f, opts);
      result.applied.push(f.file);
    }
    return result;
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
