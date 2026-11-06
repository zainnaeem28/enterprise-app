// `integration_core.apply_inbound_secret` (ARCHITECTURE 25.9, SEC-01 O2-1..O2-9, SC-1..SC-8). The ONLY writer of an
// `inbound_verification` secret. The entered value reaches the worker as a sealed job payload (opened with the request ID
// as context); it is never in a table. The job writes only when ALL of this holds:
//   - the request is `approved` and not expired (a row the `api` can write is not evidence by itself);
//   - the worker recomputes the canonical bytes from the opened value and compares them with the stored bytes (O2-2);
//   - the injected {@link ApprovalEvidenceVerifier} accepts both assertions over the challenge (O2-3, O2-4, O2-7).
// The default verifier refuses everything: until identity (BE-05) supplies a WebAuthn verifier, no admin-entered secret can
// be applied, which is the safe failure (O2-9: no break-glass bypass). Failures leave the secret unchanged, close the
// request as `rejected`, audit the refusal by class, and publish `integration_core.secret_change_refused` (compliance alert).
import { randomUUID } from 'node:crypto';
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';
import { isUuid, systemScope } from './scope.js';
import type { InboundSecretWriter, PayloadOpener } from './secrets.js';

export interface EvidenceInput {
  requestId: string;
  connectionId: string;
  name: string;
  requesterPersonId: string;
  approverPersonId: string;
  /** SHA-256 of the canonical bytes: what both assertions must have signed. */
  challenge: Buffer;
  requesterAssertion: unknown;
  approverAssertion: unknown;
  now: Date;
}

export type EvidenceVerdict = { ok: true } | { ok: false; reason: string };

/** O2-3/O2-4: verifies two WebAuthn assertions against enrolled, anchored, aged credentials. Supplied by identity. */
export interface ApprovalEvidenceVerifier {
  verify(input: EvidenceInput): Promise<EvidenceVerdict>;
}

/** Fails closed: nothing is accepted until a real verifier is configured. */
export const refusingVerifier: ApprovalEvidenceVerifier = {
  verify: () => Promise.resolve({ ok: false, reason: 'no_verifier_configured' }),
};

export interface ApplyDeps {
  db: KernelDb;
  orgId: string;
  queue: Queue;
  log: Logger;
  opener: PayloadOpener;
  writer: InboundSecretWriter;
  verifier?: ApprovalEvidenceVerifier;
  now?: () => Date;
}

export type ApplyResult =
  | { status: 'applied'; versionId: string }
  | { status: 'waiting' }
  | { status: 'closed'; was: string }
  | { status: 'refused'; reason: string };

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

async function audit(
  tx: Tx,
  orgId: string,
  jobId: string,
  action: 'secret_write' | 'config_change',
  requestId: string,
  change: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, change, outcome)
     VALUES ($1::uuid, $2::uuid, $3, 'worker', 'system', $4, 'integration_core.secret_change_request', $5::uuid, $6::jsonb, 'allowed')`,
    [randomUUID(), orgId, jobId, action, requestId, JSON.stringify(change)],
  );
}

export async function runApplySecret(
  deps: ApplyDeps,
  payload: { requestId: string; sealed: string },
): Promise<ApplyResult> {
  const { requestId } = payload;
  if (!isUuid(requestId) || typeof payload.sealed !== 'string')
    throw new Error('integration_core.apply_inbound_secret: bad payload');
  const now = (deps.now ?? (() => new Date()))();
  const scope = systemScope(deps.orgId);
  const jobId = `integration_core.apply_inbound_secret:${requestId}`;

  const req = (
    await deps.db.withScope(scope, (tx) =>
      tx.query(
        `SELECT id, connection_id, name, requester_person_id, approver_person_id, status, expires_at, canonical_request,
                requester_assertion, approver_assertion
           FROM integration_core.secret_change_request WHERE id = $1::uuid`,
        [requestId],
      ),
    )
  ).rows[0];
  if (req === undefined)
    throw new Error('integration_core.apply_inbound_secret: request not found');
  const status = String(req.status);
  if (status === 'applied' || status === 'rejected' || status === 'expired')
    return { status: 'closed', was: status }; // idempotent: a re-run after success or refusal changes nothing

  const expiresAt = req.expires_at as Date;
  if (now >= expiresAt) {
    await deps.db.withScope(scope, (tx) =>
      tx
        .query(
          `UPDATE integration_core.secret_change_request SET status = 'expired' WHERE id = $1::uuid AND status IN ('requested','approved')`,
          [requestId],
        )
        .then(() => undefined),
    );
    return { status: 'closed', was: 'expired' };
  }
  if (status === 'requested') return { status: 'waiting' }; // not approved yet: the caller re-enqueues the job

  const refuse = async (reason: string): Promise<ApplyResult> => {
    const r = REASON.test(reason) ? reason : 'refused';
    await deps.db.withScope(scope, async (tx) => {
      await tx.query(
        `UPDATE integration_core.secret_change_request SET status = 'rejected', job_id = $2 WHERE id = $1::uuid AND status = 'approved'`,
        [requestId, jobId],
      );
      await audit(tx, deps.orgId, jobId, 'config_change', requestId, {
        outcome: 'refused',
        reasonClass: r,
      });
      await deps.queue.publish(tx, 'integration_core.secret_change_refused', {
        requestId,
        organisationId: deps.orgId,
      });
    });
    deps.log.warn('inbound secret change refused', { reasonClass: r });
    return { status: 'refused', reason: r };
  };

  // O2-2: open the payload, recompute everything, trust nothing from request_hash.
  let value: string;
  let nonce: Buffer;
  try {
    const plain = JSON.parse(
      (
        await deps.opener.open(Buffer.from(payload.sealed, 'base64'), `secret_change:${requestId}`)
      ).toString('utf8'),
    ) as {
      value?: unknown;
      nonce?: unknown;
    };
    if (typeof plain.value !== 'string' || typeof plain.nonce !== 'string')
      throw new Error('shape');
    value = plain.value;
    nonce = Buffer.from(plain.nonce, 'base64');
  } catch {
    return refuse('payload_unreadable');
  }
  const canonical = canonicalRequest({
    requestId,
    connectionId: String(req.connection_id),
    name: String(req.name),
    valueFingerprintHex: valueFingerprint(requestId, nonce, value),
    requesterPersonId: String(req.requester_person_id),
    expiresAt,
  });
  if (!canonical.equals(req.canonical_request as Buffer)) return refuse('canonical_mismatch');

  const approver = req.approver_person_id === null ? undefined : String(req.approver_person_id);
  if (approver === undefined || approver === String(req.requester_person_id))
    return refuse('approver_invalid');
  if (req.requester_assertion === null || req.approver_assertion === null)
    return refuse('assertion_missing');

  const verdict = await (deps.verifier ?? refusingVerifier).verify({
    requestId,
    connectionId: String(req.connection_id),
    name: String(req.name),
    requesterPersonId: String(req.requester_person_id),
    approverPersonId: approver,
    challenge: challengeOf(canonical),
    requesterAssertion: req.requester_assertion,
    approverAssertion: req.approver_assertion,
    now,
  });
  if (!verdict.ok) return refuse(verdict.reason);

  // Store write first, idempotent by request ID (a crash between the two steps repeats the same version), then the
  // reference and the request state in one transaction.
  const written = await deps.writer.put(String(req.name), value, requestId);
  await deps.db.withScope(scope, async (tx) => {
    await tx.query(
      `INSERT INTO integration_core.secret_ref (connection_id, name, organisation_id, class, secret_arn, current_version_id, rotated_at, created_by_job)
       VALUES ($1::uuid, $2, $3::uuid, 'inbound_verification', $4, $5, now(), NULL)
       ON CONFLICT (connection_id, name) DO UPDATE
         SET secret_arn = EXCLUDED.secret_arn, current_version_id = EXCLUDED.current_version_id, rotated_at = now()`,
      [req.connection_id, req.name, deps.orgId, written.arn, written.versionId],
    );
    const moved = await tx.query(
      `UPDATE integration_core.secret_change_request
          SET status = 'applied', applied_at = now(), applied_version_id = $2, job_id = $3
        WHERE id = $1::uuid AND status = 'approved'`,
      [requestId, written.versionId, jobId],
    );
    // BR-BE02-02: no request moved (concurrent close) -> throw so the reference and the audit row roll back.
    if (moved.rowCount !== 1)
      throw new Error('integration_core.apply_inbound_secret: request no longer approved');
    await audit(tx, deps.orgId, jobId, 'secret_write', requestId, {
      name: String(req.name),
      versionId: written.versionId,
    });
  });
  return { status: 'applied', versionId: written.versionId };
}
