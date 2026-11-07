// Transaction-local settings the admin handlers set themselves, and the B2 pre-verification read (ARCHITECTURE 21.2, 21.3,
// 26.1). The claim read runs under the NOLOGIN role `identity_signin_ro`, whose only rights are the column grants of 21.2 and
// the T-SIGNIN-CLAIM policies. This wrapper allows exactly the two claim reads while the role is switched and runs
// `RESET ROLE` in `finally` (SEC-01 RO-1..RO-3, CL-1, CL-2). The handle must already have passed `normaliseHandle`.
import type { Tx } from '@ehr/kernel';
import { normaliseHandle } from './handle.js';

export async function setLocal(tx: Tx, name: string, value: string): Promise<void> {
  if (!/^app\.[a-z_]+$/.test(name)) throw new Error('bad setting name');
  await tx.query(`SELECT set_config($1, $2, true)`, [name, value]);
}

export interface ClaimedCredential {
  id: Buffer;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
}
export interface Claim {
  principalId: string | undefined;
  credentials: ClaimedCredential[];
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Always runs the same two queries, whether or not the handle exists, so the timing does not depend on it (26.1).
 * An unknown, suspended or disabled handle yields `principalId: undefined` and no credentials.
 */
export async function readClaim(tx: Tx, handle: string): Promise<Claim> {
  if (normaliseHandle(handle) !== handle) throw new Error('claim handle is not normalised');
  await setLocal(tx, 'app.auth_claim_handle', handle);
  await tx.query('SET LOCAL ROLE identity_signin_ro');
  try {
    const p = await tx.query(
      `SELECT id FROM identity.principal WHERE realm = 'admin_pool' AND subject = $1 AND status = 'active'`,
      [handle],
    );
    const principalId = p.rows[0]?.['id'] as string | undefined;
    const c = await tx.query(
      `SELECT id, public_key, sign_count, transports FROM identity.admin_credential
        WHERE principal_id = $1 AND revoked_at IS NULL ORDER BY id`,
      [principalId ?? NIL_UUID],
    );
    return {
      principalId,
      credentials: c.rows.map((r) => ({
        id: r['id'] as Buffer,
        publicKey: r['public_key'] as Buffer,
        signCount: Number(r['sign_count']),
        transports: (r['transports'] as string[] | null) ?? [],
      })),
    };
  } finally {
    await tx.query('RESET ROLE').catch(() => undefined); // an aborted transaction rolls the role back by itself
  }
}
