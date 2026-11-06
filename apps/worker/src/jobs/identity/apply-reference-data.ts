// `identity.apply_reference_data`: loads the permission catalogue (27.2), the roles and the default mapping (27.3) into
// `identity.permission`, `identity.role` and `identity.role_permission` as audience `system`. Idempotent: running it twice
// leaves the tables as they were. The mapping is a PROPOSAL until G2 (the version label and the role descriptions say so);
// changing it is an edit of reference-data.ts and a re-run, reviewed like any other change (a `config_change` audit event
// records the checksum before and after).
import { createHash, randomUUID } from 'node:crypto';
import type { KernelDb, Tx } from '@ehr/kernel';
import { uuidv7 } from './ids.js';
import {
  PERMISSIONS,
  PROPOSAL_NOTE,
  REFERENCE_DATASET,
  REFERENCE_VERSION,
  ROLES,
} from './reference-data.js';
import type { PermissionSeed, RoleSeed } from './reference-data.js';
import { systemScope } from './scope.js';

export class ReferenceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceDataError';
  }
}

/** Expands `prefix.*`, applies `minus`, and checks the rules the database also enforces (BD-05 rule 1). */
export function expandRole(
  role: RoleSeed,
  catalogue: readonly PermissionSeed[] = PERMISSIONS,
): string[] {
  const byKey = new Map(catalogue.map((p) => [p.key, p]));
  const out = new Set<string>();
  for (const entry of role.permissions) {
    if (entry.endsWith('.*')) {
      const prefix = entry.slice(0, -1);
      const matches = catalogue.filter(
        (p) => p.key.startsWith(prefix) && (role.privileged || !p.privileged),
      );
      if (matches.length === 0)
        throw new ReferenceDataError(`${role.key}: ${entry} matches no permission`);
      for (const m of matches) out.add(m.key);
      continue;
    }
    const p = byKey.get(entry);
    if (p === undefined) throw new ReferenceDataError(`${role.key}: unknown permission ${entry}`);
    if (p.privileged && !role.privileged)
      throw new ReferenceDataError(`${role.key}: ${entry} is for privileged roles only`);
    out.add(entry);
  }
  for (const m of role.minus ?? []) {
    if (!out.delete(m)) throw new ReferenceDataError(`${role.key}: minus ${m} removes nothing`);
  }
  if (role.privileged && role.realm !== 'admin_pool')
    throw new ReferenceDataError(`${role.key}: privileged roles live in admin_pool`);
  return [...out].sort();
}

export function expandedMapping(): { role: RoleSeed; permissions: string[] }[] {
  return ROLES.map((role) => ({ role, permissions: expandRole(role) }));
}

export function checksum(): Buffer {
  const body = JSON.stringify({
    permissions: PERMISSIONS,
    roles: expandedMapping().map((m) => ({ ...m.role, permissions: m.permissions })),
  });
  return createHash('sha256').update(body).digest();
}

export interface ApplyReferenceDeps {
  db: KernelDb;
  orgId: string;
  jobId?: string;
}

export interface ApplyReferenceResult {
  permissions: number;
  roles: number;
  mappings: number;
  changed: boolean;
}

async function upsert(tx: Tx, orgId: string): Promise<ApplyReferenceResult> {
  for (const p of PERMISSIONS) {
    await tx.query(
      `INSERT INTO identity.permission (organisation_id, key, module, privileged, needs_elevation, compliance_scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organisation_id, key) DO UPDATE
         SET module = EXCLUDED.module, privileged = EXCLUDED.privileged, needs_elevation = EXCLUDED.needs_elevation, compliance_scope = EXCLUDED.compliance_scope
       WHERE (identity.permission.module, identity.permission.privileged, identity.permission.needs_elevation, identity.permission.compliance_scope)
             IS DISTINCT FROM (EXCLUDED.module, EXCLUDED.privileged, EXCLUDED.needs_elevation, EXCLUDED.compliance_scope)`,
      [orgId, p.key, p.module, p.privileged, p.needsElevation, p.complianceScope],
    );
  }
  let mappings = 0;
  for (const { role, permissions } of expandedMapping()) {
    const description = `${PROPOSAL_NOTE}`;
    const existing = (
      await tx.query(
        `SELECT id, realm FROM identity.role WHERE organisation_id = $1 AND key = $2`,
        [orgId, role.key],
      )
    ).rows[0];
    let roleId: string;
    if (existing === undefined) {
      roleId = uuidv7();
      await tx.query(
        `INSERT INTO identity.role (id, organisation_id, key, realm, privileged, location_bound, description) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [roleId, orgId, role.key, role.realm, role.privileged, role.locationBound, description],
      );
    } else {
      roleId = existing['id'] as string;
      if (existing['realm'] !== role.realm)
        throw new ReferenceDataError(`${role.key}: a role never changes realm`);
      await tx.query(
        `UPDATE identity.role SET privileged = $2, location_bound = $3, description = $4
          WHERE id = $1 AND (privileged, location_bound, description) IS DISTINCT FROM ($2, $3, $4)`,
        [roleId, role.privileged, role.locationBound, description],
      );
    }
    await tx.query(
      `DELETE FROM identity.role_permission WHERE role_id = $1 AND permission_key <> ALL($2::text[])`,
      [roleId, permissions],
    );
    await tx.query(
      `INSERT INTO identity.role_permission (organisation_id, role_id, permission_key)
       SELECT $1, $2, k FROM unnest($3::text[]) AS k ON CONFLICT (role_id, permission_key) DO NOTHING`,
      [orgId, roleId, permissions],
    );
    mappings += permissions.length;
  }
  return { permissions: PERMISSIONS.length, roles: ROLES.length, mappings, changed: false };
}

export async function runApplyReferenceData(
  deps: ApplyReferenceDeps,
): Promise<ApplyReferenceResult> {
  const sum = checksum();
  return deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const before = (
      await tx.query(
        `SELECT version, checksum FROM kernel.reference_data_version WHERE organisation_id = $1 AND dataset = $2`,
        [deps.orgId, REFERENCE_DATASET],
      )
    ).rows[0];
    const result = await upsert(tx, deps.orgId);
    const beforeSum = before === undefined ? null : (before['checksum'] as Buffer).toString('hex');
    const changed = beforeSum !== sum.toString('hex');
    await tx.query(
      `INSERT INTO kernel.reference_data_version (organisation_id, dataset, version, applied_at, checksum, created_by_job)
       VALUES ($1, $2, $3, now(), $4, $5)
       ON CONFLICT (organisation_id, dataset) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at, checksum = EXCLUDED.checksum`,
      [deps.orgId, REFERENCE_DATASET, REFERENCE_VERSION, sum, null],
    );
    if (changed) {
      await tx.query(
        `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, change, outcome)
         VALUES ($1::uuid, $2::uuid, $3, 'worker', 'system', 'config_change', 'identity.role', $4::jsonb, 'allowed')`,
        [
          randomUUID(),
          deps.orgId,
          deps.jobId ?? 'identity.apply_reference_data',
          JSON.stringify({
            dataset: REFERENCE_DATASET,
            version: REFERENCE_VERSION,
            checksumBefore: beforeSum,
            checksumAfter: sum.toString('hex'),
          }),
        ],
      );
    }
    return { ...result, changed };
  });
}
