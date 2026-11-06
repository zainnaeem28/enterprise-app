// The assignment resolver (ARCHITECTURE 27.4, BQ-5 default): `isAssigned(principal, patient)` is true when
//   - the principal has an active care-team row for the patient (or a patient in its closure),
//   - there is a not-cancelled reservation for the patient with the principal as clinician, starting no earlier than
//     `assignment_lookback_months` ago, or
//   - the principal authored or co-signed an encounter or note for the patient,
// and, for an assistant, when any doctor they currently support is assigned (`staff_support`, Proposal G-10), and, for a
// trainee, when the supervisor is. The three data sources belong to patient, scheduling and clinical, which identity
// cannot import (SHARED-BOUNDARIES 3.2): each registers its lookup here, and a registration may be missing in a build
// where the module does not exist yet, which makes that rule answer "no" (fail closed).
import type { Tx } from '@ehr/kernel';

export type AssignmentRule = 'care_team' | 'reservation' | 'authored';

/** One indexed lookup. Must run in the caller's transaction and be bounded by the caller's own scope. */
export type AssignmentSource = (
  tx: Tx,
  principalId: string,
  patientId: string,
  opts: { lookbackMonths: number },
) => Promise<boolean>;

export const DEFAULT_LOOKBACK_MONTHS = 24;

export class AssignmentResolver {
  private readonly sources = new Map<AssignmentRule, AssignmentSource>();

  registerSource(rule: AssignmentRule, source: AssignmentSource): void {
    if (this.sources.has(rule)) throw new Error(`assignment source ${rule} already registered`);
    this.sources.set(rule, source);
  }

  async lookbackMonths(tx: Tx): Promise<number> {
    const { rows } = await tx.query(
      `SELECT value FROM kernel.setting WHERE key = 'assignment_lookback_months' AND location_id IS NULL`,
    );
    const v = rows[0]?.['value'];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 240
      ? v
      : DEFAULT_LOOKBACK_MONTHS;
  }

  /** Direct assignment of one principal, by the three rules. */
  private async direct(
    tx: Tx,
    principalId: string,
    patientId: string,
    lookbackMonths: number,
  ): Promise<boolean> {
    for (const rule of ['care_team', 'reservation', 'authored'] as const) {
      const src = this.sources.get(rule);
      if (src !== undefined && (await src(tx, principalId, patientId, { lookbackMonths })))
        return true;
    }
    return false;
  }

  /** The doctors this principal answers for today: the supervisor of a trainee and every supported doctor of an assistant. */
  async supportedDoctors(tx: Tx, principalId: string): Promise<string[]> {
    const { rows } = await tx.query(
      `SELECT supervisor_principal_id AS id FROM identity.staff_profile WHERE principal_id = $1 AND supervisor_principal_id IS NOT NULL
       UNION
       SELECT supported_principal_id FROM identity.staff_support
        WHERE assistant_principal_id = $1 AND from_date <= current_date AND (to_date IS NULL OR to_date >= current_date)`,
      [principalId],
    );
    return rows.map((r) => r['id'] as string);
  }

  async isAssigned(tx: Tx, principalId: string, patientId: string): Promise<boolean> {
    const months = await this.lookbackMonths(tx);
    if (await this.direct(tx, principalId, patientId, months)) return true;
    for (const doctor of await this.supportedDoctors(tx, principalId)) {
      if (await this.direct(tx, doctor, patientId, months)) return true;
    }
    return false;
  }
}

/** Permissions whose use is assignment-bound (27.3 `doctor`: "clinical.* (assignment-bound reads, 27.4)"). */
export const ASSIGNMENT_BOUND_PERMISSIONS: ReadonlySet<string> = new Set(['clinical.chart.read']);
