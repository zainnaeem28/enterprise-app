import type { PoolClientLike, PoolLike, Queryable, QueryResult } from '../db.js';
import { applyAuthIdentity, applyScope } from './settings.js';
import type { AuthIdentity, ScopeSettings } from './settings.js';

/** Functions owned by `patient_scope_owner` (SHARED-BOUNDARIES 6.2). Each needs `lockPatients` first (25.2). */
export const PATIENT_SCOPE_OWNER_FUNCTIONS: readonly string[] = [
  'patient.register',
  'patient.ensure_care_relationship',
  'patient.ensure_referral_care_relationship',
  'patient.attach',
  'patient.end_care_relationship',
  'patient.begin_merge',
  'patient.complete_merge',
  'patient.verify_staff_scope',
];

export type LockMode = 'key_share' | 'no_key_update';

export class LockOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockOrderError';
  }
}

/** The transaction handle. It exists only inside {@link KernelDb.withScope}; there is no other way to run a query. */
export class Tx implements Queryable {
  private locked: { ids: Set<string>; mode: LockMode } | undefined;
  private finished = false;

  constructor(
    private readonly client: PoolClientLike,
    readonly scope: Readonly<ScopeSettings>,
  ) {}

  /** @internal */
  _finish(): void {
    this.finished = true;
  }

  query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (this.finished)
      throw new LockOrderError('transaction handle used after the transaction ended');
    return this.client.query(sql, params);
  }

  /**
   * `patient.lock_patients(ids, mode)` (21.6, 25.2 rule 1): all roots at the start, ascending ID order (the function
   * sorts; we sort too so the call is deterministic), strongest mode needed. Called once per transaction.
   */
  async lockPatients(ids: readonly string[], mode: LockMode): Promise<void> {
    if (this.locked !== undefined)
      throw new LockOrderError('lockPatients may be called once, at the start of the transaction');
    const sorted = [...new Set(ids.map((x) => x.toLowerCase()))].sort();
    await this.query('SELECT patient.lock_patients($1::uuid[], $2)', [sorted, mode]);
    this.locked = { ids: new Set(sorted), mode };
  }

  /**
   * `patient.lock_referral_patient(referral, patient, mode)` (ruling HEAAA-325, A-4): the root lock of an accept or decline
   * transaction, where the receiving location has no care relationship yet. The basis is the pending referral addressed to the
   * caller's location, checked in the database. Same once-per-transaction rule as {@link lockPatients}.
   */
  async lockReferralPatient(referralId: string, patientId: string, mode: LockMode): Promise<void> {
    if (this.locked !== undefined)
      throw new LockOrderError('lockPatients may be called once, at the start of the transaction');
    await this.query('SELECT patient.lock_referral_patient($1::uuid, $2::uuid, $3)', [
      referralId,
      patientId,
      mode,
    ]);
    this.locked = { ids: new Set([patientId.toLowerCase()]), mode };
  }

  /** Runtime half of the lock-order rule: a `patient_scope_owner` function runs only after `lockPatients`. */
  async callScopeOwner(
    fn: string,
    args: unknown[],
    patientIds: readonly string[] = [],
  ): Promise<QueryResult> {
    if (!PATIENT_SCOPE_OWNER_FUNCTIONS.includes(fn))
      throw new LockOrderError(`${fn} is not a patient_scope_owner function`);
    if (this.locked === undefined) throw new LockOrderError(`${fn} called before lockPatients`);
    if (this.locked.mode !== 'no_key_update') {
      throw new LockOrderError(`${fn} needs lockPatients(..., 'no_key_update') (25.2 rule 1)`);
    }
    for (const id of patientIds) {
      if (!this.locked.ids.has(id.toLowerCase()))
        throw new LockOrderError(`${fn} names a patient that was not locked`);
    }
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    return this.query(`SELECT * FROM ${fn}(${placeholders})`, args);
  }
}

/** Only the identity sign-in handlers may use this (CI call-site check, 21.3). */
export class SignInTx extends Tx {
  setAuthIdentity(id: AuthIdentity): Promise<void> {
    return applyAuthIdentity(this, id);
  }
}

export interface ScopeOptions {
  /** A request with an Idempotency-Key, or a read: only these are retried after 40P01/40001 (25.2 rule 4). */
  idempotent?: boolean;
  maxRetries?: number;
  /** Test hook for the jitter. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set(['40P01', '40001']);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class KernelDb {
  constructor(private readonly pool: PoolLike) {}

  withScope<T>(
    scope: ScopeSettings,
    fn: (tx: Tx) => Promise<T>,
    opts: ScopeOptions = {},
  ): Promise<T> {
    return this.run(scope, (c, s) => new Tx(c, s), fn, opts);
  }

  /** Sign-in transactions: audience `anonymous`, with the setter. */
  withSignInScope<T>(
    scope: ScopeSettings,
    fn: (tx: SignInTx) => Promise<T>,
    opts: ScopeOptions = {},
  ): Promise<T> {
    if (scope.audience !== 'anonymous')
      throw new LockOrderError('sign-in scope requires audience anonymous');
    return this.run(scope, (c, s) => new SignInTx(c, s), fn, opts);
  }

  private async run<T, X extends Tx>(
    scope: ScopeSettings,
    make: (c: PoolClientLike, s: ScopeSettings) => X,
    fn: (tx: X) => Promise<T>,
    opts: ScopeOptions,
  ): Promise<T> {
    const max = opts.idempotent === true ? (opts.maxRetries ?? 2) : 0;
    const sleep = opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(scope, make, fn);
      } catch (err) {
        const code =
          typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
        if (attempt < max && typeof code === 'string' && RETRYABLE.has(code)) {
          await sleep(Math.floor(Math.random() * 25 * 2 ** attempt) + 5);
          continue; // a whole new transaction
        }
        throw err;
      }
    }
  }

  private async once<T, X extends Tx>(
    scope: ScopeSettings,
    make: (c: PoolClientLike, s: ScopeSettings) => X,
    fn: (tx: X) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let tx: X | undefined;
    let began = false;
    let destroy: Error | undefined;
    try {
      await client.query('BEGIN');
      began = true;
      await applyScope(client, scope);
      tx = make(client, scope);
      const result = await fn(tx);
      await client.query('COMMIT');
      began = false;
      return result;
    } finally {
      tx?._finish();
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // A connection whose rollback failed is destroyed, not returned to the pool.
          destroy = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
        }
      }
      client.release(destroy);
    }
  }
}
