// The scope builder (ARCHITECTURE 21.3, 27.1; SHARED-BOUNDARIES 6.1): turns a resolved session into the transaction
// settings every handler runs under, and into the permission grants the guard checks. It runs in the caller's own
// authenticated transaction (T-PRINCIPAL / T-CONF reads), once per request, and nothing it computes outlives the request.
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { PermissionGrants } from './types.js';
import type { PatientAccess, RoleGrant, SessionRow } from './types.js';

type Row = Record<string, unknown>;

/** What a module may add to a principal's scope (24: `registerScopeContributor`). Identity fields are not on this list. */
export type ScopeContribution = Partial<
  Pick<ScopeSettings, 'locationIds' | 'btgPatientIds' | 'patientIds' | 'proxyPatientIds' | 'pharmacyOrgId' | 'complianceScopes' | 'phiAccess'>
>;

export type ScopeContributor = (
  tx: Tx,
  base: Readonly<ScopeSettings>,
  session: Readonly<SessionRow>,
) => Promise<ScopeContribution>;

const ARRAY_KEYS = ['locationIds', 'btgPatientIds', 'patientIds', 'proxyPatientIds', 'complianceScopes'] as const;

export interface BuiltScope {
  scope: ScopeSettings;
  roles: RoleGrant[];
  grants: PermissionGrants;
  patients: PatientAccess[];
  displayName: string;
  principalActive: boolean;
}

export interface ScopeBuilderDeps {
  orgId: string;
  /** `audit.activeBtgGrants`: the staff scope includes the patients the principal has an open break-glass grant for. */
  activeBtgPatientIds: (tx: Tx, principalId: string) => Promise<string[]>;
}

export class ScopeBuilder {
  private readonly contributors: ScopeContributor[] = [];

  constructor(private readonly deps: ScopeBuilderDeps) {}

  registerScopeContributor(fn: ScopeContributor): void {
    this.contributors.push(fn);
  }

  async build(tx: Tx, session: SessionRow): Promise<BuiltScope> {
    const principal = (
      await tx.query(
        `SELECT p.status AS principal_status, pe.status AS person_status, pe.display_name
           FROM identity.principal p JOIN identity.person pe ON pe.id = p.person_id WHERE p.id = $1`,
        [session.principalId],
      )
    ).rows[0];
    const active = principal?.['principal_status'] === 'active' && principal['person_status'] === 'active';
    const displayName = typeof principal?.['display_name'] === 'string' ? principal['display_name'] : '';
    const base: ScopeSettings = {
      audience: session.audience,
      realm: session.realm,
      orgId: this.deps.orgId,
      principalId: session.principalId,
      personId: session.personId,
    };
    if (!active) return { scope: base, roles: [], grants: new PermissionGrants(), patients: [], displayName, principalActive: false };

    const roles: RoleGrant[] = [];
    const grants = new PermissionGrants();
    const locationIds = new Set<string>();
    const complianceScopes = new Set<string>();
    if (session.audience === 'staff') {
      const ra = await tx.query(
        `SELECT ra.role_id, r.key, r.privileged, ra.location_id
           FROM identity.role_assignment ra JOIN identity.role r ON r.id = ra.role_id
          WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL AND r.realm = $2`,
        [session.principalId, session.realm],
      );
      const roleIds = [...new Set(ra.rows.map((r: Row) => r['role_id'] as string))];
      const perms =
        roleIds.length === 0
          ? []
          : (
              await tx.query(
                `SELECT rp.role_id, p.key, p.needs_elevation, p.compliance_scope
                   FROM identity.role_permission rp
                   JOIN identity.permission p ON p.organisation_id = rp.organisation_id AND p.key = rp.permission_key
                  WHERE rp.role_id = ANY($1::uuid[])`,
                [roleIds],
              )
            ).rows;
      for (const a of ra.rows) {
        const locationId = (a['location_id'] as string | null) ?? undefined;
        roles.push({
          key: a['key'] as string,
          privileged: a['privileged'] === true,
          ...(locationId === undefined ? {} : { locationId }),
        });
        if (locationId !== undefined) locationIds.add(locationId);
        for (const p of perms) {
          if (p['role_id'] !== a['role_id']) continue;
          grants.add(p['key'] as string, locationId, p['needs_elevation'] === true);
          if (typeof p['compliance_scope'] === 'string' && session.realm === 'admin_pool')
            complianceScopes.add(p['compliance_scope']);
        }
      }
    }

    const patients: PatientAccess[] = [];
    if (session.audience === 'patient') {
      const self = await tx.query(`SELECT patient_id FROM identity.patient_link WHERE principal_id = $1`, [session.principalId]);
      for (const r of self.rows) patients.push({ patientId: r['patient_id'] as string, relation: 'self', scope: 'full' });
      // D-7 default: a proxy sees appointments only. A patient who is also their own proxy keeps full access.
      const proxy = await tx.query(
        `SELECT patient_id, scope, patient_display_name FROM identity.proxy_grant
          WHERE proxy_principal_id = $1 AND status = 'active' AND (valid_until IS NULL OR valid_until >= current_date)`,
        [session.principalId],
      );
      const have = new Set(patients.map((p) => p.patientId));
      for (const r of proxy.rows) {
        const id = r['patient_id'] as string;
        if (have.has(id)) continue;
        patients.push({ patientId: id, relation: 'proxy', scope: 'appointments', displayName: r['patient_display_name'] as string });
      }
    }

    let btg: string[] = [];
    if (session.audience === 'staff') btg = await this.deps.activeBtgPatientIds(tx, session.principalId);

    const scope: ScopeSettings = {
      ...base,
      ...(locationIds.size > 0 ? { locationIds: [...locationIds] } : {}),
      ...(btg.length > 0 ? { btgPatientIds: btg } : {}),
      ...(patients.length > 0 ? { patientIds: patients.map((p) => p.patientId) } : {}),
      ...(patients.some((p) => p.relation === 'proxy')
        ? { proxyPatientIds: patients.filter((p) => p.relation === 'proxy').map((p) => p.patientId) }
        : {}),
      ...(complianceScopes.size > 0 ? { complianceScopes: [...complianceScopes].sort(), phiAccess: 'limited' as const } : {}),
    };
    for (const c of this.contributors) {
      const add = await c(tx, scope, session);
      const out = scope as unknown as Record<string, unknown>;
      for (const k of ARRAY_KEYS) {
        const v = add[k];
        if (v !== undefined) out[k] = [...new Set([...((out[k] as string[] | undefined) ?? []), ...v])];
      }
      if (add.pharmacyOrgId !== undefined && scope.pharmacyOrgId === undefined) scope.pharmacyOrgId = add.pharmacyOrgId;
      // phiAccess may only narrow what identity set, never widen it.
      if (add.phiAccess !== undefined && scope.phiAccess === undefined) scope.phiAccess = add.phiAccess;
    }
    return { scope, roles, grants, patients, displayName, principalActive: true };
  }
}
