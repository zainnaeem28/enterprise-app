// webauthn_challenge rows (ARCHITECTURE 22.4, B2-5): 32 bytes from the CSPRNG, a UUID v4 ID (122 random bits), two minutes,
// single use. A challenge is consumed with one UPDATE before any session or grant is written, and a failed verification
// still burns it: the caller reports a failure by RETURNING (so the burn commits), never by throwing inside the transaction.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Tx } from '@ehr/kernel';
import { CHALLENGE_BYTES, CHALLENGE_SECONDS } from './webauthn.js';

export type ChallengePurpose = 'sign_in' | 'enrol' | 'elevation';

export interface NewChallenge {
  id: string;
  challenge: Buffer;
  expiresAt: Date;
}

export async function insertChallenge(
  tx: Tx,
  p: {
    orgId: string;
    purpose: ChallengePurpose;
    principalId: string | null;
    sessionId: string | null;
    now: Date;
  },
): Promise<NewChallenge> {
  const id = randomUUID();
  const challenge = randomBytes(CHALLENGE_BYTES);
  const expiresAt = new Date(p.now.getTime() + CHALLENGE_SECONDS * 1000);
  await tx.query(
    `INSERT INTO identity.webauthn_challenge (id, organisation_id, purpose, principal_id, session_id, challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, p.orgId, p.purpose, p.principalId, p.sessionId, challenge, expiresAt],
  );
  return { id, challenge, expiresAt };
}

export interface ConsumedChallenge {
  challenge: Buffer;
  principalId: string | null;
}

/** One statement: unused, unexpired and of this purpose, or nothing. The settings of the transaction name the row. */
export async function consumeChallenge(
  tx: Tx,
  id: string,
  purpose: ChallengePurpose,
  now: Date,
): Promise<ConsumedChallenge | undefined> {
  const r = await tx.query(
    `UPDATE identity.webauthn_challenge SET used_at = $3
      WHERE id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
      RETURNING challenge, principal_id`,
    [id, purpose, now],
  );
  const row = r.rows[0];
  return row === undefined
    ? undefined
    : {
        challenge: row['challenge'] as Buffer,
        principalId: (row['principal_id'] as string | null) ?? null,
      };
}
