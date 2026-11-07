// The admin-realm session insert (T-SIGNIN, ARCHITECTURE 26.1): after the assertion or attestation verified, in the same
// transaction as the credential write. Lifetimes follow 26.2 (10 minutes idle, 8 hours absolute for `admin_pool`).
import type { Tx } from '@ehr/kernel';
import { lifetimesFor } from '../sessions.js';

export interface NewAdminSession {
  id: string;
  orgId: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  principalId: string;
  personId: string;
  /** `hwk` for a hardware-key sign-in; `enrol` marks the session an enrolment created (two-key rule, 26.3). */
  amr: string[];
  ip: string | null;
  userAgent: string | null;
  now: Date;
}

export async function insertAdminSession(
  tx: Tx,
  s: NewAdminSession,
): Promise<{ idleExpiresAt: Date; absoluteExpiresAt: Date }> {
  const life = await lifetimesFor(tx, 'admin_pool');
  const absoluteExpiresAt = new Date(s.now.getTime() + life.absoluteMs);
  const idleExpiresAt = new Date(
    Math.min(s.now.getTime() + life.idleMs, absoluteExpiresAt.getTime()),
  );
  await tx.query(
    `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, amr,
       csrf_hash, idle_expires_at, absolute_expires_at, last_seen_at, last_interaction_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, 'admin_pool', 'staff', $6, $7, $8, $9, $10, $6, $6, $11::inet, $12)`,
    [
      s.id,
      s.orgId,
      s.tokenHash,
      s.principalId,
      s.personId,
      s.now,
      s.amr,
      s.csrfHash,
      idleExpiresAt,
      absoluteExpiresAt,
      s.ip,
      s.userAgent === null ? null : s.userAgent.slice(0, 512),
    ],
  );
  return { idleExpiresAt, absoluteExpiresAt };
}
