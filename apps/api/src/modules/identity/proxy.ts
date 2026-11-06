// identity.proxy_grant (ARCHITECTURE 4, 22.4, ST-06; D-7 default, RA-R1-20a): a linked proxy sees appointments only and
// nothing else. The table, its RLS and the scope contribution are owned here; the patient module reads them only through
// this interface (`patientAccessFor`, `listForPatient`). Verification by staff and the age-out job need the T-STAFF
// policies on `patient.staff_scope` (BE-08) and the D-7 rule values (RA-R1-20b, blocked), so they are not here.
import type { Tx } from '@ehr/kernel';
import { IdentityScopeError, IdentityValidationError } from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { PatientAccess } from './types.js';

export const PROXY_RELATIONSHIPS = ['parent', 'guardian', 'carer', 'other'] as const;
export type ProxyRelationship = (typeof PROXY_RELATIONSHIPS)[number];

export interface ProxyGrantView {
  id: string;
  patientId: string;
  relationship: ProxyRelationship;
  scope: 'appointments';
  patientDisplayName: string;
  status: 'requested' | 'verified' | 'active' | 'revoked' | 'expired';
}

const view = (r: Record<string, unknown>): ProxyGrantView => ({
  id: r['id'] as string,
  patientId: r['patient_id'] as string,
  relationship: r['relationship'] as ProxyRelationship,
  scope: 'appointments',
  patientDisplayName: r['patient_display_name'] as string,
  status: r['status'] as ProxyGrantView['status'],
});

const COLS = 'id, patient_id, relationship, patient_display_name, status';

export class ProxyService {
  /**
   * A proxy (patient audience, their own principal) asks for access: a `requested` row for themselves and nothing more.
   * The T-PRINCIPAL(proxy) INSERT policy refuses anything else, whatever this method does.
   */
  async request(
    tx: Tx,
    input: { patientId: string; relationship: ProxyRelationship; patientDisplayName: string },
  ): Promise<string> {
    const principalId = tx.scope.principalId;
    if (
      tx.scope.audience !== 'patient' ||
      principalId === undefined ||
      tx.scope.orgId === undefined
    )
      throw new IdentityScopeError();
    const bad: string[] = [];
    if (!isUuid(input.patientId)) bad.push('patientId');
    if (!PROXY_RELATIONSHIPS.includes(input.relationship)) bad.push('relationship');
    const name = input.patientDisplayName.trim();
    if (name.length < 1 || name.length > 100) bad.push('patientDisplayName');
    if (bad.length > 0) throw new IdentityValidationError(bad);
    const id = uuidv7();
    await tx.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, patient_display_name, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'appointments', $6, 'requested', $3)`,
      [id, tx.scope.orgId, principalId, input.patientId, input.relationship, name],
    );
    return id;
  }

  /** The patient (own scope, never a proxy) revokes a proxy of theirs. Returns false when no open grant matched. */
  async revokeByPatient(tx: Tx, grantId: string): Promise<boolean> {
    if (tx.scope.audience !== 'patient') throw new IdentityScopeError();
    if (!isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    const r = await tx.query(
      `UPDATE identity.proxy_grant SET status = 'revoked', revoked_at = now(), revoke_reason = 'patient'
        WHERE id = $1 AND status IN ('requested', 'verified', 'active')`,
      [grantId],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** The proxies of the patients in the caller's own scope (T-PAT-OWN). */
  async listForPatient(tx: Tx, patientId: string): Promise<ProxyGrantView[]> {
    if (!isUuid(patientId)) throw new IdentityValidationError(['patientId']);
    const r = await tx.query(
      `SELECT ${COLS} FROM identity.proxy_grant WHERE patient_id = $1 ORDER BY created_at`,
      [patientId],
    );
    return r.rows.map(view);
  }

  /** The grants of the calling proxy (T-PRINCIPAL(proxy)), so they can tell linked patients apart without reading the patient. */
  async listMine(tx: Tx): Promise<ProxyGrantView[]> {
    if (tx.scope.audience !== 'patient' || tx.scope.principalId === undefined)
      throw new IdentityScopeError();
    const r = await tx.query(
      `SELECT ${COLS} FROM identity.proxy_grant WHERE proxy_principal_id = $1 ORDER BY created_at`,
      [tx.scope.principalId],
    );
    return r.rows.map(view);
  }
}

/** What a patient session may reach, as the scope builder computed it: the interface the patient module reads (24). */
export function patientAccessOf(
  patients: readonly PatientAccess[],
  patientId: string,
): PatientAccess | undefined {
  return patients.find((p) => p.patientId === patientId);
}
