// What the patient module hands to the identity module (ARCHITECTURE 24 "Registers: scope contributor (identity)"):
//   * the scope contributor: the merged IDs that resolve to the patients (and BTG patients) already in a principal's scope (6.1);
//   * `patientInScope`: the `patient.staff_sees` probe the authorization guard uses for a resolved patient (21.4).
// Both run under the caller's own transaction and RLS; neither widens it. The recipient contributor for `notifications` runs in
// the sending job, so it lives with the worker (apps/worker/src/jobs/patient/recipient.ts).
import type { Tx } from '@ehr/kernel';
import type { PatientInScope, ScopeContributor } from '../identity/index.js';
import { isUuid } from './ids.js';

type Row = Record<string, unknown>;

/**
 * Closure of the given IDs from the merge map (9.2): every ID whose final survivor is one of them. Merged IDs are for reading only
 * (6.1); the merge write guard (0701) refuses a write that names one, whatever these sets say.
 */
async function mergedInto(tx: Tx, finals: readonly string[]): Promise<string[]> {
  if (finals.length === 0) return [];
  const r = await tx.query(
    `SELECT merged_id, final_survivor_id FROM patient.patient_merge WHERE final_survivor_id = ANY($1::uuid[])`,
    [finals],
  );
  return r.rows.map((x) => String((x as Row)['merged_id']));
}

export const patientScopeContributor: ScopeContributor = async (tx, base) => {
  if (base.audience === 'patient') {
    const own = base.patientIds ?? [];
    if (own.length === 0) return {};
    const proxyFinals = new Set(base.proxyPatientIds ?? []);
    const r = await tx.query(
      `SELECT merged_id, final_survivor_id FROM patient.patient_merge WHERE final_survivor_id = ANY($1::uuid[])`,
      [own],
    );
    if (r.rows.length === 0) return {};
    const merged = r.rows.map((x) => String((x as Row)['merged_id']));
    const proxyMerged = r.rows
      .filter((x) => proxyFinals.has(String((x as Row)['final_survivor_id'])))
      .map((x) => String((x as Row)['merged_id']));
    return {
      patientIds: merged,
      ...(proxyMerged.length > 0 ? { proxyPatientIds: proxyMerged } : {}),
    };
  }
  if (base.audience === 'staff') {
    const btg = base.btgPatientIds ?? [];
    if (btg.length === 0) return {};
    const merged = await mergedInto(tx, btg);
    return merged.length === 0 ? {} : { btgPatientIds: merged };
  }
  return {};
};

/** The guard's staff probe. The `staff_scope` policy applies the caller's own locations, so the query names no location. */
export const patientInScope: PatientInScope = async (tx, _ctx, patientId) => {
  if (!isUuid(patientId)) return false;
  const r = await tx.query(
    `SELECT 1 FROM patient.staff_scope WHERE patient_id = $1::uuid LIMIT 1`,
    [patientId],
  );
  return r.rows.length > 0;
};
