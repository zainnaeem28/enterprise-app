import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMigration } from './rules.js';
import { splitStatements } from './sql-scan.js';

const expand = (body: string): string => `-- migration-class: expand\n${body}`;
const rules = (sql: string): string[] => checkMigration(sql).map((f) => f.rule);

test('scanner ignores comments, strings, identifiers and dollar bodies', () => {
  const s = splitStatements(
    `-- INSERT in a comment;\nSELECT 'a;b', "UPDATE" /* DELETE; */; CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $b$ SELECT 1; DELETE FROM t; $b$;`,
  );
  assert.equal(s.length, 2);
  assert.match(s[0]!.masked, /^SELECT/);
  assert.doesNotMatch(s[1]!.masked, /DELETE/);
  assert.equal(s[1]!.text.length, s[1]!.masked.length);
});

test('E-strings honour backslash escapes', () => {
  assert.equal(splitStatements(`SELECT E'it\\'s; fine'; SELECT 2`).length, 2);
});

for (const [name, sql] of [
  ['INSERT', 'INSERT INTO kernel.setting (key) VALUES (1)'],
  ['UPDATE', 'UPDATE kernel.setting SET key = 1'],
  ['DELETE', 'DELETE FROM kernel.setting'],
  ['MERGE', 'MERGE INTO kernel.setting t USING s ON true WHEN MATCHED THEN DELETE'],
  ['COPY', "COPY kernel.setting FROM '/tmp/x'"],
  ['psql \\copy', '\\copy kernel.setting from x'],
  ['TRUNCATE', 'TRUNCATE kernel.setting'],
  ['DO block', 'DO $$ BEGIN UPDATE t SET a = 1; END $$'],
  ['CTE DML', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'],
  ['SELECT INTO', 'SELECT * INTO t2 FROM t'],
  ['CTAS', 'CREATE TABLE t2 AS SELECT * FROM t'],
  ['lower case and odd spacing', '  insert\n  into t values (1)'],
] as const) {
  test(`DML ban rejects ${name} (SBR-17)`, () => {
    assert.ok(rules(expand(sql)).includes('DML'), name);
  });
}

test('DML ban does not reject DDL that mentions DML words', () => {
  const sql = expand(
    `CREATE TABLE t_audit_insert (id uuid PRIMARY KEY, "update" text);\nCOMMENT ON TABLE t_audit_insert IS 'INSERT; UPDATE';\nGRANT INSERT, UPDATE ON t_audit_insert TO app_api;`,
  );
  assert.deepEqual(rules(sql), []);
});

test('the runner owns transactions, role switching and timeouts; roles come from db/roles', () => {
  assert.ok(rules(expand('COMMIT')).includes('RUNNER_OWNED'));
  assert.ok(rules(expand('SET ROLE app_api')).includes('RUNNER_OWNED'));
  assert.ok(rules(expand('SET LOCAL lock_timeout = 0')).includes('RUNNER_OWNED'));
  assert.ok(rules(expand('CREATE ROLE evil BYPASSRLS')).includes('ROLE_DDL'));
});

test('a file without a class header is rejected', () => {
  assert.deepEqual(rules('CREATE TABLE t (id int)'), ['CLASS_HEADER']);
});

// Expand/contract rule fixtures (DEVOPS-PLAN 8.1 and 5.2).
for (const [name, body] of [
  ['DROP TABLE', 'DROP TABLE t'],
  ['DROP COLUMN', 'ALTER TABLE t DROP COLUMN c'],
  ['DROP CONSTRAINT', 'ALTER TABLE t DROP CONSTRAINT k'],
  ['RENAME COLUMN', 'ALTER TABLE t RENAME COLUMN a TO b'],
  ['RENAME TABLE', 'ALTER TABLE t RENAME TO u'],
  ['column type change', 'ALTER TABLE t ALTER COLUMN a TYPE bigint'],
  ['SET NOT NULL', 'ALTER TABLE t ALTER COLUMN a SET NOT NULL'],
  ['NOT NULL column without default', 'ALTER TABLE t ADD COLUMN a int NOT NULL'],
] as const) {
  test(`expand file rejects ${name}`, () => {
    assert.ok(rules(expand(body)).includes('EXPAND_DESTRUCTIVE'), name);
  });
}

for (const [name, body] of [
  ['non-concurrent index on an existing table', 'CREATE INDEX i ON t (a)'],
  ['unique index on an existing table', 'CREATE UNIQUE INDEX i ON t (a)'],
  [
    'foreign key that validates immediately',
    'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id)',
  ],
  ['check that validates immediately', 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0)'],
  ['primary key built in place', 'ALTER TABLE t ADD PRIMARY KEY (a)'],
  ['volatile default', 'ALTER TABLE t ADD COLUMN a uuid DEFAULT gen_random_uuid()'],
  ['serial column', 'ALTER TABLE t ADD COLUMN a bigserial'],
] as const) {
  test(`expand file rejects ${name}`, () => {
    assert.ok(rules(expand(body)).includes('EXPAND_LOCKING'), name);
  });
}

test('expand file accepts the safe forms', () => {
  assert.deepEqual(
    rules(
      expand(`
CREATE TABLE fresh (id uuid PRIMARY KEY, a int NOT NULL);
CREATE INDEX fresh_a ON fresh (a);
ALTER TABLE fresh ADD CONSTRAINT fresh_a_pos CHECK (a > 0);
ALTER TABLE t ADD COLUMN b int NOT NULL DEFAULT 0;
ALTER TABLE t ADD COLUMN c text;
ALTER TABLE t ADD CONSTRAINT t_c_ck CHECK (char_length(c) <= 10) NOT VALID;
DROP POLICY IF EXISTS p ON t;
CREATE POLICY p ON t FOR SELECT TO app_api USING (true);`),
    ),
    [],
  );
});

test('CREATE INDEX CONCURRENTLY needs "-- transaction: none"', () => {
  assert.ok(rules(expand('CREATE INDEX CONCURRENTLY i ON t (a)')).includes('EXPAND_LOCKING'));
  assert.deepEqual(
    rules('-- migration-class: expand\n-- transaction: none\nCREATE INDEX CONCURRENTLY i ON t (a)'),
    [],
  );
});

test('contract file needs an approval reference and only destructive statements', () => {
  const head = '-- migration-class: contract\n';
  assert.ok(rules(`${head}ALTER TABLE t DROP COLUMN c`).includes('CONTRACT_APPROVAL'));
  assert.deepEqual(rules(`${head}-- contract-approval: HEAAA-0\nALTER TABLE t DROP COLUMN c`), []);
  assert.ok(
    rules(`${head}-- contract-approval: HEAAA-0\nCREATE TABLE u (id int)`).includes(
      'CONTRACT_MIXED',
    ),
  );
});
