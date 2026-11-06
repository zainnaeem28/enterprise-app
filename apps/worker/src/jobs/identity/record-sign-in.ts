// `identity.record_sign_in`: the audit event of a sign-in, a first-sign-in provisioning and a pre-registered email binding
// (ARCHITECTURE 26.1, 22.4 SEC01-F-08). The sign-in transaction runs as audience `anonymous`, which cannot write to
// `audit.event` (21.3), so it queues this job in the same transaction (the event and the sign-in commit together or not at
// all) and the job writes the event as `system`. Retries are safe: event IDs derive from the session ID and an existing
// event is not written twice. A binding also publishes `identity.principal_bound`, to which the notifications module
// attaches the PHI-free notice to the admin who pre-registered the principal.
import { createHash } from 'node:crypto';
import type { KernelDb, Queue } from '@ehr/kernel';
import { isUuid, systemScope } from './scope.js';

export type SignInKind = 'sign_in' | 'created' | 'bound';
const KINDS: readonly string[] = ['sign_in', 'created', 'bound'];

export interface RecordSignInDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue, for the `identity.principal_bound` event. */
  queue?: Queue;
  /** The configured Workspace domain, recorded as `hd` in a binding event (the callback verified it equals the token's). */
  workspaceDomain?: string;
}

/** A deterministic UUID per (purpose, session): the retry of a job finds its own event. */
export function eventIdFor(purpose: string, sessionId: string): string {
  const h = createHash('sha256').update(`identity:${purpose}:${sessionId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const INSERT = `INSERT INTO audit.event (event_id, organisation_id, job_id, actor_principal_id, actor_person_id, realm, audience, action,
    resource_type, resource_id, change, outcome)
  SELECT $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::uuid, $11::jsonb, 'allowed'
   WHERE NOT EXISTS (SELECT 1 FROM audit.event e WHERE e.event_id = $1::uuid)`;

export async function runRecordSignIn(
  deps: RecordSignInDeps,
  payload: { principalId?: unknown; sessionId?: unknown; kind?: unknown },
  jobId: string,
): Promise<{ written: number }> {
  const { principalId, sessionId, kind } = payload;
  if (!isUuid(principalId) || !isUuid(sessionId) || typeof kind !== 'string' || !KINDS.includes(kind))
    throw new Error('identity.record_sign_in: bad payload');
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const p = (
      await tx.query(`SELECT person_id, realm, subject, email, created_by FROM identity.principal WHERE id = $1`, [principalId])
    ).rows[0];
    if (p === undefined) throw new Error('identity.record_sign_in: principal not found');
    const audience = p['realm'] === 'patient_pool' ? 'patient' : 'staff';
    let written = 0;
    const write = async (purpose: string, action: 'sign_in' | 'update', type: string, resourceId: string, change: Record<string, unknown> | null) => {
      const r = await tx.query(INSERT, [
        eventIdFor(purpose, sessionId),
        deps.orgId,
        jobId,
        principalId,
        p['person_id'],
        p['realm'],
        audience,
        action,
        type,
        resourceId,
        change === null ? null : JSON.stringify(change),
      ]);
      written += r.rowCount ?? 0;
    };
    await write('sign_in', 'sign_in', 'identity.session', sessionId, kind === 'created' ? { provisioned: true } : null);
    if (kind === 'bound') {
      await write('bound', 'update', 'identity.principal', principalId, {
        bound: 'subject',
        sub: p['subject'],
        email: p['email'],
        ...(deps.workspaceDomain === undefined ? {} : { hd: deps.workspaceDomain }),
      });
      const preregisteredBy = p['created_by'];
      if (deps.queue !== undefined && isUuid(preregisteredBy))
        await deps.queue.publish(tx, 'identity.principal_bound', { principalId, preregisteredBy }, { jobKey: sessionId });
    }
    return { written };
  });
}
