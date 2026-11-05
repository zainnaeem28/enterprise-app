import { splitStatements, type Statement } from './sql-scan.js';

export type RuleId =
  | 'DML' // SBR-17, ARCHITECTURE 21.7 point 1
  | 'RUNNER_OWNED' // transaction control, role switching: the runner owns them
  | 'ROLE_DDL' // roles are created by db/roles, not by migrations
  | 'CLASS_HEADER' // DEVOPS-PLAN 8.1: every file declares expand or contract
  | 'EXPAND_DESTRUCTIVE' // DEVOPS-PLAN 8.1 rule 1
  | 'EXPAND_LOCKING' // DEVOPS-PLAN 5.2: non-concurrent index, validating constraint, rewrite
  | 'CONTRACT_APPROVAL'
  | 'CONTRACT_MIXED';

export interface Finding {
  readonly rule: RuleId;
  readonly statement: number;
  readonly message: string;
  readonly excerpt: string;
}

export type MigrationClass = 'expand' | 'contract';

export interface MigrationHeader {
  readonly class: MigrationClass | null;
  /** `-- transaction: none` runs each statement on its own (needed by CREATE INDEX CONCURRENTLY). */
  readonly transaction: 'single' | 'none';
  readonly contractApproval: string | null;
}

export function parseHeader(sql: string): MigrationHeader {
  const get = (key: string): string | null => {
    const m = new RegExp(`^--\\s*${key}:[ \\t]*(.*)$`, 'im').exec(sql);
    return m ? (m[1] ?? '').trim() : null;
  };
  const cls = get('migration-class');
  return {
    class: cls === 'expand' || cls === 'contract' ? cls : null,
    transaction: get('transaction') === 'none' ? 'none' : 'single',
    contractApproval: get('contract-approval') || null,
  };
}

const first = (s: Statement): string =>
  (/^\s*([A-Za-z_\\]+)/.exec(s.masked)?.[1] ?? '').toUpperCase();
const norm = (s: Statement): string => s.masked.replace(/\s+/g, ' ').trim().toUpperCase();
const excerpt = (s: Statement): string => s.text.split('\n')[0]!.slice(0, 80);

const DML_FIRST = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'COPY',
  'TRUNCATE',
  'DO',
  'CALL',
  'EXECUTE',
]);

function dmlFinding(s: Statement): string | null {
  const w = first(s);
  const n = norm(s);
  if (w.startsWith('\\')) return 'psql meta-command (for example \\copy)';
  if (DML_FIRST.has(w)) return `${w} statement`;
  if (w === 'WITH' && /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(n))
    return 'data-modifying WITH statement';
  if (w === 'SELECT' && /\bINTO\b/.test(n)) return 'SELECT ... INTO creates data';
  if (w === 'CREATE' && /^CREATE (?:\w+ )*TABLE\b.*\bAS\b/.test(n))
    return 'CREATE TABLE AS creates data';
  if (/\bBEGIN ATOMIC\b/.test(n)) return 'BEGIN ATOMIC body (use a dollar-quoted body)';
  return null;
}

const RUNNER_OWNED =
  /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE TRANSACTION|SET (?:SESSION |LOCAL )?(?:ROLE|SESSION AUTHORIZATION)|RESET (?:ROLE|SESSION AUTHORIZATION|ALL)|SET (?:SESSION |LOCAL )?(?:LOCK_TIMEOUT|STATEMENT_TIMEOUT|TRANSACTION_TIMEOUT)|ALTER SYSTEM)\b/;
const ROLE_DDL = /^(CREATE|ALTER|DROP) (ROLE|USER|GROUP)\b/;

const CREATED_TABLE = /^CREATE (?:UNLOGGED |TEMP(?:ORARY)? )?TABLE (?:IF NOT EXISTS )?([\w."]+)/;
const ALTER_TABLE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+)/;
const INDEX_ON =
  /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:[\w."]+ )?ON (?:ONLY )?([\w."]+)/;

const VOLATILE_DEFAULT =
  /\bDEFAULT\s+(?:\w+\.)?(RANDOM|GEN_RANDOM_UUID|UUID_GENERATE_V\d\w*|CLOCK_TIMESTAMP|TIMEOFDAY|NEXTVAL)\s*\(/;

/** Destructive or contracting: allowed only in a `contract` file. */
function destructive(n: string): string | null {
  if (/^DROP (POLICY|TRIGGER)\b/.test(n)) return null; // re-creating a policy or trigger is idempotent expand
  if (/^DROP\b/.test(n)) return 'DROP';
  if (/^ALTER TABLE\b.*\bDROP (COLUMN|CONSTRAINT)\b/.test(n)) return 'DROP COLUMN/CONSTRAINT';
  if (/^ALTER\b.*\bRENAME\b/.test(n)) return 'RENAME';
  if (/^ALTER TABLE\b.*\bALTER (?:COLUMN )?\w+ (?:SET DATA )?TYPE\b/.test(n))
    return 'column type change';
  return null;
}

export interface CheckOptions {
  /** Skip the expand/contract rules (used only for the DML ban tool run on raw SQL). */
  readonly structureOnly?: boolean;
}

/** Statement-level rules for one migration file's SQL. Pure: no database access. */
export function checkMigration(sql: string, opts: CheckOptions = {}): Finding[] {
  const header = parseHeader(sql);
  const statements = splitStatements(sql);
  const out: Finding[] = [];
  const add = (rule: RuleId, i: number, s: Statement, message: string): void => {
    out.push({ rule, statement: i + 1, message, excerpt: excerpt(s) });
  };

  const created = new Set<string>();
  for (const s of statements) {
    const m = CREATED_TABLE.exec(norm(s));
    if (m) created.add(m[1]!.toLowerCase());
  }
  const fresh = (name: string | undefined): boolean =>
    name !== undefined && created.has(name.toLowerCase());

  statements.forEach((s, i) => {
    const n = norm(s);
    const dml = dmlFinding(s);
    if (dml)
      add(
        'DML',
        i,
        s,
        `Migrations are DDL only (SBR-17): ${dml}. Reference data and repairs are worker jobs.`,
      );
    if (RUNNER_OWNED.test(n))
      add(
        'RUNNER_OWNED',
        i,
        s,
        'Transaction control, role switching and timeouts are owned by the runner.',
      );
    if (ROLE_DDL.test(n))
      add('ROLE_DDL', i, s, 'Roles are created by db/roles, never by a migration.');
  });

  if (opts.structureOnly) return out;

  if (header.class === null) {
    out.push({
      rule: 'CLASS_HEADER',
      statement: 0,
      message:
        'The file must declare "-- migration-class: expand" or "-- migration-class: contract" (DEVOPS-PLAN 8.1).',
      excerpt: '',
    });
    return out;
  }

  if (header.class === 'contract') {
    if (!header.contractApproval) {
      out.push({
        rule: 'CONTRACT_APPROVAL',
        statement: 0,
        message:
          'A contract migration needs "-- contract-approval: <decision reference>" (DEVOPS-PLAN 8.1 rule 1).',
        excerpt: '',
      });
    }
    statements.forEach((s, i) => {
      if (destructive(norm(s)) === null && !dmlFinding(s) && !RUNNER_OWNED.test(norm(s))) {
        add(
          'CONTRACT_MIXED',
          i,
          s,
          'A contract file holds only destructive statements; behaviour and expansion go in an expand file.',
        );
      }
    });
    return out;
  }

  statements.forEach((s, i) => {
    const n = norm(s);
    const d = destructive(n);
    if (d)
      add(
        'EXPAND_DESTRUCTIVE',
        i,
        s,
        `${d} is a contraction; it needs its own contract migration and approval (DEVOPS-PLAN 8.1 rule 1).`,
      );

    const alter = ALTER_TABLE.exec(n);
    if (alter && !fresh(alter[1])) {
      if (/\bSET NOT NULL\b/.test(n))
        add(
          'EXPAND_DESTRUCTIVE',
          i,
          s,
          'SET NOT NULL on an existing table has no default-and-backfill plan.',
        );
      if (
        /\bADD (?:COLUMN )?(?:IF NOT EXISTS )?\w+ [^,]*\bNOT NULL\b/.test(n) &&
        !/\bDEFAULT\b/.test(n)
      ) {
        add(
          'EXPAND_DESTRUCTIVE',
          i,
          s,
          'ADD COLUMN ... NOT NULL without a constant DEFAULT fails or rewrites a populated table.',
        );
      }
      if (/\bADD (?:CONSTRAINT \w+ )?(FOREIGN KEY|CHECK)\b/.test(n) && !/\bNOT VALID\b/.test(n)) {
        add(
          'EXPAND_LOCKING',
          i,
          s,
          'Add the constraint NOT VALID and validate it in a later step (DEVOPS-PLAN 5.2).',
        );
      }
      if (/\bADD (?:CONSTRAINT \w+ )?(PRIMARY KEY|UNIQUE)\b(?! USING INDEX)/.test(n)) {
        add(
          'EXPAND_LOCKING',
          i,
          s,
          'Build the index CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX.',
        );
      }
      if (
        /\bADD (?:COLUMN )?(?:IF NOT EXISTS )?\w+ [^,]*(\bGENERATED\b.*\bSTORED\b|\bSERIAL\b|\bBIGSERIAL\b)/.test(
          n,
        )
      ) {
        add('EXPAND_LOCKING', i, s, 'Stored generated and serial columns rewrite the table.');
      }
    }
    if (alter && VOLATILE_DEFAULT.test(n) && !fresh(alter[1])) {
      add(
        'EXPAND_LOCKING',
        i,
        s,
        'A volatile DEFAULT rewrites the table; use a constant default (ARCHITECTURE 21.7 point 1).',
      );
    }

    const idx = INDEX_ON.exec(n);
    if (idx && !fresh(idx[1]) && !/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY\b/.test(n)) {
      add(
        'EXPAND_LOCKING',
        i,
        s,
        'CREATE INDEX on an existing table must be CONCURRENTLY (DEVOPS-PLAN 8.1 rule 1).',
      );
    }
  });

  if (
    header.transaction === 'single' &&
    statements.some((s) => /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY\b/.test(norm(s)))
  ) {
    out.push({
      rule: 'EXPAND_LOCKING',
      statement: 0,
      message:
        'CREATE INDEX CONCURRENTLY cannot run in a transaction; add "-- transaction: none" (and keep the file to that statement).',
      excerpt: '',
    });
  }
  return out;
}
