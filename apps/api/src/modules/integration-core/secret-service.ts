// Write-only secret references (BD-11, ARCHITECTURE 9.1, 25.9; SEC-01 SC-1..SC-8, O2-1..O2-9).
//   outbound            admin writes through `writeOutbound`: value -> store, then reference + audit(version ID) in ONE tx.
//   inbound_verification admin REQUESTS (`requestInboundSecret`), a DIFFERENT elevated admin DECIDES (`decide`); only the
//                       worker applies it, after re-checking the approval evidence (apps/worker .../apply-secret.ts).
// A secret value is never returned, logged, audited, stored in a table or put in an error. The value exists in this module
// only as the argument of `writeOutbound`/`requestInboundSecret`, for the duration of that call.
import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '@ehr/kernel';
import { AuditService, type RequestMeta } from '../audit/index.js';
import { canonicalRequest, challengeOf, valueFingerprint } from './canonical.js';
import { isAdminScope } from './connections.js';
import {
  IntegrationNotFoundError,
  IntegrationScopeError,
  IntegrationValidationError,
  RequestExpiredError,
  RequestStateError,
  SecretStoreUnavailableError,
  SelfApprovalError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { OutboundSecretStore, PayloadSealer } from './secret-store.js';

export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const OUTBOUND_MIN_LENGTH = 8;
export const INBOUND_MIN_LENGTH = 16; // SC-6: the minimum stated for an entered verification secret
export const MAX_SECRET_LENGTH = 4096;
export const REQUEST_LIFETIME_MS = 30 * 60_000;

/** The WebAuthn assertion fields the worker verifies (O2-3). All base64url; they carry no secret value. */
export interface Assertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

const B64URL = /^[A-Za-z0-9_-]{1,4096}$/;
function validAssertion(a: unknown): a is Assertion {
  if (a === null || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  const keys = ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature'];
  return (
    Object.keys(o).length === keys.length &&
    keys.every((k) => typeof o[k] === 'string' && B64URL.test(o[k] as string))
  );
}

/** Enqueues `integration_core.apply_inbound_secret` with the sealed value. See README open note INT-N4. */
export type SealedJobEnqueuer = (
  tx: Tx,
  job: { requestId: string; sealed: string },
) => Promise<void>;

export interface SecretServiceDeps {
  audit: AuditService;
  store: OutboundSecretStore;
  sealer: PayloadSealer;
  enqueueApply?: SealedJobEnqueuer;
  now?: () => Date;
}

export interface InboundRequestReceipt {
  requestId: string;
  expiresAt: Date;
  /** First and last 6 hex characters of the salted fingerprint, for the out-of-band confirmation (O2-6). Not the value. */
  fingerprintHint: string;
}

function validValue(v: unknown, min: number): v is string {
  return (
    typeof v === 'string' &&
    v.length >= min &&
    v.length <= MAX_SECRET_LENGTH &&
    !v.includes('\u0000')
  );
}

export class SecretService {
  constructor(private readonly d: SecretServiceDeps) {}

  /**
   * `PUT /admin/integrations/{id}/secrets/{name}` (25.9). Returns the new version ID only. If the database part fails after
   * the store write, the new version exists but is not current; a retry with the same idempotency key writes no second one.
   */
  async writeOutbound(
    tx: Tx,
    meta: RequestMeta,
    input: { connectionId: string; name: string; value: string; idempotencyKey: string },
  ): Promise<{ versionId: string }> {
    if (!isAdminScope(tx.scope)) throw new IntegrationScopeError();
    const problems: string[] = [];
    if (!isUuid(input.connectionId)) problems.push('connectionId');
    if (!SECRET_NAME.test(input.name)) problems.push('name');
    if (!isUuid(input.idempotencyKey)) problems.push('idempotencyKey');
    if (!validValue(input.value, OUTBOUND_MIN_LENGTH)) problems.push('value');
    if (problems.length > 0) throw new IntegrationValidationError(problems);

    const conn = (
      await tx.query('SELECT id FROM integration_core.connection WHERE id = $1::uuid', [
        input.connectionId,
      ])
    ).rows[0];
    if (conn === undefined) throw new IntegrationNotFoundError();
    const existing = (
      await tx.query(
        'SELECT class FROM integration_core.secret_ref WHERE connection_id = $1::uuid AND name = $2',
        [input.connectionId, input.name],
      )
    ).rows[0];
    // The API role never writes an inbound-verification reference, even by reusing its name (BD-11).
    if (existing !== undefined && existing.class !== 'outbound') throw new IntegrationScopeError();

    const clientToken = createHash('sha256')
      .update(
        `${tx.scope.principalId}\u0000${input.idempotencyKey}\u0000${input.connectionId}\u0000${input.name}`,
      )
      .digest('hex');
    let stored: { arn: string; versionId: string };
    try {
      stored = await this.d.store.put(
        { connectionId: input.connectionId, name: input.name },
        input.value,
        clientToken,
      );
    } catch {
      throw new SecretStoreUnavailableError(); // no vendor text, no value
    }
    await tx.query(
      `INSERT INTO integration_core.secret_ref
         (connection_id, name, organisation_id, class, secret_arn, current_version_id, rotated_at, rotated_by_person_id, created_by)
       VALUES ($1::uuid, $2, $3::uuid, 'outbound', $4, $5, now(), $6::uuid, $7::uuid)
       ON CONFLICT (connection_id, name) DO UPDATE
         SET secret_arn = EXCLUDED.secret_arn, current_version_id = EXCLUDED.current_version_id,
             rotated_at = now(), rotated_by_person_id = EXCLUDED.rotated_by_person_id`,
      [
        input.connectionId,
        input.name,
        tx.scope.orgId,
        stored.arn,
        stored.versionId,
        tx.scope.personId,
        tx.scope.principalId ?? null,
      ],
    );
    await this.d.audit.record(tx, {
      requestId: meta.requestId,
      action: 'secret_write',
      resourceType: 'integration_core.secret_ref',
      resourceId: input.connectionId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { name: input.name, versionId: stored.versionId }, // the version ID, never the value (BD-08)
    });
    return { versionId: stored.versionId };
  }

  /**
   * Step 1 of an admin-entered inbound-verification secret. Stores the request (canonical bytes, hash, requester's
   * assertion), seals the value for the worker and hands it to the job enqueuer. The value is in no table.
   */
  async requestInboundSecret(
    tx: Tx,
    meta: RequestMeta,
    input: { connectionId: string; name: string; value: string; requesterAssertion: Assertion },
  ): Promise<InboundRequestReceipt> {
    if (!isAdminScope(tx.scope)) throw new IntegrationScopeError();
    const problems: string[] = [];
    if (!isUuid(input.connectionId)) problems.push('connectionId');
    if (!SECRET_NAME.test(input.name)) problems.push('name');
    if (!validValue(input.value, INBOUND_MIN_LENGTH)) problems.push('value');
    if (!validAssertion(input.requesterAssertion)) problems.push('requesterAssertion');
    if (problems.length > 0) throw new IntegrationValidationError(problems);
    if (this.d.enqueueApply === undefined) throw new SecretStoreUnavailableError(); // fail closed: nothing could apply it

    const conn = (
      await tx.query('SELECT id FROM integration_core.connection WHERE id = $1::uuid', [
        input.connectionId,
      ])
    ).rows[0];
    if (conn === undefined) throw new IntegrationNotFoundError();

    const requestId = uuidv7();
    const nonce = randomBytes(16);
    const expiresAt = new Date(
      (this.d.now ?? (() => new Date()))().getTime() + REQUEST_LIFETIME_MS,
    );
    const fingerprint = valueFingerprint(requestId, nonce, input.value);
    const canonical = canonicalRequest({
      requestId,
      connectionId: input.connectionId,
      name: input.name,
      valueFingerprintHex: fingerprint,
      requesterPersonId: tx.scope.personId as string,
      expiresAt,
    });
    await tx.query(
      `INSERT INTO integration_core.secret_change_request
         (id, organisation_id, connection_id, name, requester_person_id, request_hash, canonical_request, expires_at, requester_assertion, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::timestamptz, $9::jsonb, $10::uuid)`,
      [
        requestId,
        tx.scope.orgId,
        input.connectionId,
        input.name,
        tx.scope.personId,
        challengeOf(canonical),
        canonical,
        expiresAt.toISOString(),
        JSON.stringify(input.requesterAssertion),
        tx.scope.principalId ?? null,
      ],
    );
    let sealed: Buffer;
    try {
      sealed = await this.d.sealer.seal(
        Buffer.from(
          JSON.stringify({ value: input.value, nonce: nonce.toString('base64') }),
          'utf8',
        ),
        `secret_change:${requestId}`,
      );
    } catch {
      throw new SecretStoreUnavailableError();
    }
    await this.d.enqueueApply(tx, { requestId, sealed: sealed.toString('base64') });
    await this.d.audit.record(tx, {
      requestId: meta.requestId,
      action: 'config_change',
      resourceType: 'integration_core.secret_change_request',
      resourceId: requestId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: {
        event: 'inbound_secret_requested',
        name: input.name,
        connectionId: input.connectionId,
      },
    });
    return {
      requestId,
      expiresAt,
      fingerprintHint: `${fingerprint.slice(0, 6)}…${fingerprint.slice(-6)}`,
    };
  }

  /**
   * Step 2: a DIFFERENT elevated admin approves or rejects. Approval records the approver's assertion; the worker, not this
   * method, decides whether the evidence is good enough to write (O2-2/O2-3). An approval here is never sufficient by itself.
   */
  async decide(
    tx: Tx,
    meta: RequestMeta,
    input: { requestId: string; decision: 'approve' | 'reject'; approverAssertion?: Assertion },
  ): Promise<{ status: 'approved' | 'rejected' }> {
    if (!isAdminScope(tx.scope)) throw new IntegrationScopeError();
    if (!isUuid(input.requestId) || (input.decision !== 'approve' && input.decision !== 'reject'))
      throw new IntegrationValidationError(['requestId', 'decision']);
    if (input.decision === 'approve' && !validAssertion(input.approverAssertion))
      throw new IntegrationValidationError(['approverAssertion']);
    const req = (
      await tx.query(
        `SELECT requester_person_id, status, expires_at, now() >= expires_at AS expired
           FROM integration_core.secret_change_request WHERE id = $1::uuid`,
        [input.requestId],
      )
    ).rows[0];
    if (req === undefined) throw new IntegrationNotFoundError();
    if (req.requester_person_id === tx.scope.personId) throw new SelfApprovalError();
    if (req.expired === true) throw new RequestExpiredError();
    if (req.status !== 'requested') throw new RequestStateError();
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    // The status guard is in the statement itself, so two deciders cannot both win; the loser changes no row.
    const moved = await tx.query(
      `UPDATE integration_core.secret_change_request
          SET status = $2, approver_person_id = $3::uuid, decided_at = now(), approver_assertion = $4::jsonb
        WHERE id = $1::uuid AND status = 'requested'`,
      [
        input.requestId,
        status,
        tx.scope.personId,
        input.approverAssertion === undefined ? null : JSON.stringify(input.approverAssertion),
      ],
    );
    if (moved.rowCount !== 1) throw new RequestStateError();
    await this.d.audit.record(tx, {
      requestId: meta.requestId,
      action: 'config_change',
      resourceType: 'integration_core.secret_change_request',
      resourceId: input.requestId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { event: 'inbound_secret_decision', decision: status },
    });
    return { status };
  }
}
