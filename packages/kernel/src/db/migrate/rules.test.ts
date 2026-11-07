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
  ['EXPLAIN ANALYZE INSERT', 'EXPLAIN ANALYZE INSERT INTO t VALUES (1)'],
  ['EXPLAIN (ANALYZE) DELETE', 'EXPLAIN (ANALYZE) DELETE FROM t'],
  [
    'CREATE RULE with DML action',
    'CREATE RULE r AS ON UPDATE TO t DO ALSO INSERT INTO u VALUES (1)',
  ],
  ['parenthesised INSERT', '(INSERT INTO t VALUES (1))'],
  ['CTAS with column list', 'CREATE TABLE t2 (a, b) AS SELECT 1, 2'],
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

test('DML ban does not reject a generated column (F03-R1-03)', () => {
  const sql = expand('CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) STORED)');
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

// Owner steps (ARCHITECTURE 21.2 point 5, amendment A-3).
const GRANT = 'GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner;';
const REVOKE = 'REVOKE EXECUTE ON FUNCTION patient.guard_open_patient() FROM app_owner;';
const step = (role: string, body: string): string =>
  `SET LOCAL ROLE ${role};\n${body}\nRESET ROLE;`;
const attach =
  `${step('patient_scope_owner', GRANT)}\n` +
  'CREATE TRIGGER t_guard_open BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();\n' +
  `${step('patient_scope_owner', REVOKE)}`;
const contract = (body: string): string =>
  `-- migration-class: contract\n-- contract-approval: HEAAA-190\n${body}`;

test('owner step: the guard grant, the trigger and the revoke are accepted in an expand file', () => {
  assert.deepEqual(rules(expand(attach)), []);
  assert.deepEqual(rules(expand(attach.toLowerCase())), []);
});

test('owner step: DROP FUNCTION is accepted in a contract file only', () => {
  const drop = step('scheduling_booking_owner', 'DROP FUNCTION scheduling.guard_open_patient();');
  assert.deepEqual(rules(contract(drop)), []);
  assert.ok(rules(expand(drop)).includes('OWNER_STEP'));
});

for (const [name, sql, rule] of [
  ['another role', step('app_api', GRANT), 'RUNNER_OWNED'],
  ['a role the list does not name', step('patient_match_owner', GRANT), 'RUNNER_OWNED'],
  [
    'SET ROLE without LOCAL',
    `SET ROLE patient_scope_owner;\n${GRANT}\nRESET ROLE;`,
    'RUNNER_OWNED',
  ],
  [
    'SET SESSION AUTHORIZATION',
    step('patient_scope_owner', 'SET SESSION AUTHORIZATION app_api;'),
    'RUNNER_OWNED',
  ],
  [
    'a guard grant as scheduling_booking_owner',
    step('scheduling_booking_owner', GRANT),
    'OWNER_STEP',
  ],
  [
    'a grant of another function',
    step('patient_scope_owner', 'GRANT EXECUTE ON FUNCTION patient.register() TO app_owner;'),
    'OWNER_STEP',
  ],
  [
    'a grant to another role',
    step(
      'patient_scope_owner',
      'GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_api;',
    ),
    'OWNER_STEP',
  ],
  [
    'a table statement',
    step('patient_scope_owner', 'ALTER TABLE patient.patient DISABLE ROW LEVEL SECURITY;'),
    'OWNER_STEP',
  ],
  ['a statement outside a step after RESET ROLE alone', 'RESET ROLE;', 'RUNNER_OWNED'],
  [
    'a nested step',
    'SET LOCAL ROLE patient_scope_owner;\nSET LOCAL ROLE scheduling_booking_owner;\nRESET ROLE;',
    'OWNER_STEP',
  ],
  ['an unterminated step', `SET LOCAL ROLE patient_scope_owner;\n${REVOKE}`, 'OWNER_STEP'],
  [
    'a grant without its revoke',
    `${step('patient_scope_owner', GRANT)}\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();`,
    'OWNER_STEP',
  ],
  [
    'a revoke before the last CREATE TRIGGER',
    `${step('patient_scope_owner', GRANT)}\n${step('patient_scope_owner', REVOKE)}\nCREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient();`,
    'OWNER_STEP',
  ],
] as const) {
  test(`owner step refuses ${name}`, () => {
    assert.ok(rules(expand(sql)).includes(rule), name);
  });
}

for (const [name, drop] of [
  ['CASCADE', 'DROP FUNCTION scheduling.guard_open_patient() CASCADE;'],
  ['IF EXISTS', 'DROP FUNCTION IF EXISTS scheduling.guard_open_patient();'],
  ['an unqualified name', 'DROP FUNCTION guard_open_patient();'],
  ['DROP TABLE', 'DROP TABLE scheduling.slot_reservation;'],
] as const) {
  test(`owner step: a contract DROP FUNCTION step refuses ${name}`, () => {
    assert.ok(rules(contract(step('scheduling_booking_owner', drop))).includes('OWNER_STEP'), name);
  });
}

test('owner step needs a single-transaction file', () => {
  assert.ok(
    rules(`-- migration-class: expand\n-- transaction: none\n${attach}`).includes('OWNER_STEP'),
  );
});
