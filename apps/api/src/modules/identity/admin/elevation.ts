// The guard's elevation check (C1, ARCHITECTURE 25.8, 27.1): a privileged route needs a live `elevation_grant` on the
// caller's own session. Live means: not revoked, not past `expires_at`, on a live admin-realm session, and issued on a
// credential that has not been revoked since. The clock is the application's (injectable); nothing is cached, so a kill
// switch, a role removal or a credential revocation takes effect on the next request.
import type { KernelDb } from '@ehr/kernel';
import type { ElevationChecker } from '../guard-policy.js';
import type { AuthContext } from '../types.js';

export class GrantElevationChecker implements ElevationChecker {
  constructor(
    private readonly db: KernelDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isElevated(ctx: AuthContext): Promise<boolean> {
    if (ctx.session.realm !== 'admin_pool') return false;
    const now = this.now();
    return this.db.withScope(
      ctx.scope,
      async (tx) => {
        const r = await tx.query(
          `SELECT 1
             FROM identity.elevation_grant g
             JOIN identity.admin_credential c ON c.id = g.credential_id AND c.revoked_at IS NULL
            WHERE g.session_id = $1 AND g.revoked_at IS NULL AND g.expires_at > $2 AND g.issued_at <= $2
            LIMIT 1`,
          [ctx.session.id, now],
        );
        return r.rows.length === 1;
      },
      { idempotent: true },
    );
  }
}
