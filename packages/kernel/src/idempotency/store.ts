import type { Tx } from '../scope/with-scope.js';

export const REPLAY_BODY_LIMIT = 64 * 1024;

export class IdempotencyConflictError extends Error {
  readonly code = 'kernel.idempotency_conflict';
  readonly status = 409;
  constructor() {
    super('idempotency key reused with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyKeyRequiredError extends Error {
  readonly code = 'kernel.idempotency_key_required';
  readonly status = 400;
  constructor() {
    super('Idempotency-Key header required');
    this.name = 'IdempotencyKeyRequiredError';
  }
}

export interface StoredResponse {
  status: number;
  /** Null when the body exceeded 64 KB: the caller re-reads the resource and sets `Idempotent-Replay: true`. */
  body: Buffer | null;
  location: string | null;
}

export type BeginResult =
  { kind: 'new' } | { kind: 'replay'; response: StoredResponse; reread: boolean };

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === '') throw new IdempotencyKeyRequiredError();
  if (!KEY.test(header) || !/^.{14}[47]/.test(header)) throw new IdempotencyKeyRequiredError();
  return header.toLowerCase();
}

/**
 * Step 1 of a state-changing request, inside the business transaction (28.3, 25.1 step 1).
 * The insert comes first. A concurrent duplicate waits on the unique index until the first transaction ends:
 * if it committed, ON CONFLICT DO NOTHING returns no row and we replay; if it rolled back, our insert succeeds and
 * we proceed as new. The row's organisation and principal come from the transaction scope, via the column defaults
 * of kernel.setting helpers (the policy's WITH CHECK enforces them).
 */
export async function beginIdempotent(
  tx: Tx,
  routeTemplate: string,
  key: string,
  hash: Buffer,
): Promise<BeginResult> {
  const inserted = await tx.query(
    `INSERT INTO kernel.idempotency_key
       (organisation_id, principal_id, route_template, key, request_hash, state, expires_at)
     VALUES (kernel.uuid1('app.org_id'), kernel.uuid1('app.principal_id'), $1, $2::uuid, $3, 'in_progress', now() + interval '24 hours')
     ON CONFLICT (organisation_id, principal_id, route_template, key) DO NOTHING
     RETURNING key`,
    [routeTemplate, key, hash],
  );
  if (inserted.rows.length === 1) return { kind: 'new' };

  const existing = await tx.query(
    `SELECT request_hash, state, response_status, response_body, response_location
       FROM kernel.idempotency_key
      WHERE organisation_id = kernel.uuid1('app.org_id') AND principal_id = kernel.uuid1('app.principal_id')
        AND route_template = $1 AND key = $2::uuid`,
    [routeTemplate, key],
  );
  const row = existing.rows[0];
  if (row === undefined) return { kind: 'new' }; // expired and purged between the two statements: treat as new
  const stored = row['request_hash'];
  if (!Buffer.isBuffer(stored) || !stored.equals(hash)) throw new IdempotencyConflictError();
  if (row['state'] !== 'completed') {
    // Same transaction re-entering, or a row left in_progress by a crash that somehow committed. Never replay a
    // half-written outcome: let the caller proceed as new; the completion below overwrites the row.
    return { kind: 'new' };
  }
  const body = row['response_body'];
  const response: StoredResponse = {
    status: Number(row['response_status']),
    body: Buffer.isBuffer(body) ? body : null,
    location: typeof row['response_location'] === 'string' ? row['response_location'] : null,
  };
  return { kind: 'replay', response, reread: response.body === null };
}

/** Last step, same transaction: store the response so the commit publishes it together with the business change. */
export async function completeIdempotent(
  tx: Tx,
  routeTemplate: string,
  key: string,
  response: { status: number; body: Buffer; location?: string },
): Promise<void> {
  const body = response.body.length <= REPLAY_BODY_LIMIT ? response.body : null;
  await tx.query(
    `UPDATE kernel.idempotency_key
        SET state = 'completed', response_status = $3, response_body = $4, response_location = $5
      WHERE organisation_id = kernel.uuid1('app.org_id') AND principal_id = kernel.uuid1('app.principal_id')
        AND route_template = $1 AND key = $2::uuid`,
    [routeTemplate, key, response.status, body, response.location ?? null],
  );
}
