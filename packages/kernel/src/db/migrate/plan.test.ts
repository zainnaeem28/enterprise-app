import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertRules, loadMigrations, MigrationError, planPending } from './plan.js';
import { migrate, type SqlClient } from './runner.js';

// dist/db/migrate/*.js -> src/db/migrate/fixtures
const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../src/db/migrate/fixtures/${name}`, import.meta.url));

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof MigrationError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

/** In-memory stand-in for the tracker table: enough to exercise ordering, not SQL. */
function fakeClient(
  applied: { version: number; name: string; sha256: string }[],
): SqlClient & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query(text, params) {
      sql.push(text);
      if (/FROM migration\.schema_migration/.test(text))
        return { rows: applied.map((a) => ({ ...a })) };
      if (/INSERT INTO migration\.schema_migration/.test(text)) {
        const [version, name, sha256] = params as [number, string, string];
        applied.push({ version, name, sha256 });
      }
      return { rows: [] };
    },
  };
}

test('migrations load in version order and pass the rules', () => {
  const files = loadMigrations(fixture('ok'));
  assert.deepEqual(
    files.map((f) => f.version),
    [1, 2],
  );
  assertRules(files);
});

test('the runner rejects an out-of-order version instead of applying it silently', async () => {
  const files = loadMigrations(fixture('out-of-order'));
  // 0001 and 0003 are applied; 0002 shows up later.
  const applied = files
    .filter((f) => f.version !== 2)
    .map((f) => ({ version: f.version, name: f.name, sha256: f.sha256 }));
  assert.equal(
    code(() => planPending(files, applied)),
    'OUT_OF_ORDER',
  );

  const db = fakeClient(applied);
  await assert.rejects(
    migrate(db, { dir: fixture('out-of-order') }),
    (e: unknown) => e instanceof MigrationError && e.code === 'OUT_OF_ORDER',
  );
  assert.equal(db.sql.filter((s) => /^(BEGIN|COMMIT)/.test(s)).length, 0, 'nothing was applied');
  assert.equal(applied.length, 2, 'tracker unchanged');
});

test('in-order pending versions are applied, once, in order', async () => {
  const db = fakeClient([]);
  const first = await migrate(db, { dir: fixture('ok') });
  assert.deepEqual(first.applied, ['0001_create_widget.sql', '0002_add_note.sql']);
  const second = await migrate(db, { dir: fixture('ok') });
  assert.deepEqual(second.applied, []);
});

test('a changed or missing applied migration is rejected', () => {
  const files = loadMigrations(fixture('ok'));
  const a = files.map((f) => ({ version: f.version, name: f.name, sha256: f.sha256 }));
  assert.equal(
    code(() => planPending(files, [{ ...a[0]!, sha256: '0'.repeat(64) }])),
    'CHANGED_APPLIED',
  );
  assert.equal(
    code(() => planPending(files.slice(1), a)),
    'MISSING_APPLIED',
  );
});

test('the runner fails a directory that contains DML before it touches the database (SBR-17)', async () => {
  const db = fakeClient([]);
  await assert.rejects(migrate(db, { dir: fixture('dml') }), (e: unknown) => {
    return (
      e instanceof MigrationError &&
      e.code === 'RULE_VIOLATION' &&
      e.findings.some((f) => f.rule === 'DML') &&
      /0002_seed_widget\.sql/.test(e.message)
    );
  });
  assert.equal(db.sql.length, 0, 'no statement was sent');
});
