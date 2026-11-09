// The real `TargetResolver` of the alert service (ARCHITECTURE 22.13, 25.5; INT04-F10-D, SEC05-F03). Composed in the API
// because it reads `identity` tables, which `notifications` may not import. It runs inside the caller's transaction (the
// worker's system scope for compliance alerts, the nurse's own scope for a red flag), so identity's RLS decides what it sees.
import type { Tx } from '@ehr/kernel';
import type { TargetResolver } from './modules/notifications/alerts/index.js';

/** The principal who caused the alert is never its recipient (a person is not told about their own action). Jobs have none. */
const actorOf = (tx: Tx): string | null => tx.scope.principalId ?? null;

export function createTargetResolver(): TargetResolver {
  return {
    /**
     * Active `admin_pool` principals with an open (unrevoked) assignment of a role that grants the permission, excluding
     * the actor. Admin-realm roles are never location-bound, so there is no location filter.
     */
    async permissionHolders(tx, permission) {
      const r = await tx.query(
        `SELECT DISTINCT p.id::text AS id
           FROM identity.principal p
           JOIN identity.role_assignment ra ON ra.principal_id = p.id AND ra.revoked_at IS NULL
           JOIN identity.role ro ON ro.id = ra.role_id AND ro.realm = 'admin_pool'
           JOIN identity.role_permission rp ON rp.role_id = ro.id AND rp.permission_key = $2
          WHERE p.organisation_id = $1::uuid AND p.realm = 'admin_pool' AND p.status = 'active'
            AND ($3::uuid IS NULL OR p.id <> $3::uuid)
          ORDER BY id`,
        [tx.scope.orgId, permission, actorOf(tx)],
      );
      return r.rows.map((x) => String((x as { id: string }).id));
    },
    /** Active `google` principals holding the role at one of the locations, excluding the actor. */
    async roleHolders(tx, roleKey, locationIds) {
      const r = await tx.query(
        `SELECT DISTINCT p.id::text AS id
           FROM identity.principal p
           JOIN identity.role_assignment ra ON ra.principal_id = p.id AND ra.revoked_at IS NULL
           JOIN identity.role ro ON ro.id = ra.role_id AND ro.realm = 'google' AND ro.key = $2
          WHERE p.organisation_id = $1::uuid AND p.realm = 'google' AND p.status = 'active'
            AND ra.location_id = ANY ($4::uuid[])
            AND ($3::uuid IS NULL OR p.id <> $3::uuid)
          ORDER BY id`,
        [tx.scope.orgId, roleKey, actorOf(tx), [...locationIds]],
      );
      return r.rows.map((x) => String((x as { id: string }).id));
    },
  };
}
