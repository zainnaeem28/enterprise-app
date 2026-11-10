// `patient.exportPart` (ARCHITECTURE 22.16, SHARED-BOUNDARIES 3.2 rule 6): the patient module sits below `privacy`, so the export
// assembly calls it downwards (listed in `AssembleDeps.downward`) and it is not registered in the participant registry. It runs in the
// export job's transaction as `system` in a patients-scope job whose `job_patient_ids` hold the patient and every merged ID, and
// returns the records the patient module owns for them. Not exported: match checks, duplicate flags (they name OTHER patients), the
// staff-scope table and the merge request bookkeeping (staff identities; the final survivor is in `merges`).
import type { ExportContributor, Tx } from '@ehr/kernel';
import { isUuid } from './ids.js';

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

export const patientExportContributor: ExportContributor = {
  module: 'patient',
  async exportPart(tx: Tx, patientIds: readonly string[]): Promise<unknown> {
    if (patientIds.length === 0 || patientIds.some((p) => !isUuid(p)))
      throw new Error('patient.exportPart: bad patient ids');
    const ids = [...patientIds];
    const q = async (sql: string): Promise<Row[]> => (await tx.query(sql, [ids])).rows as Row[];
    const patients = await q(
      `SELECT id, mrn, given_name, family_name, middle_name, date_of_birth, sex_at_birth, gender_identity, phone_e164, email, address,
              state_code, preferred_language, photo_document_id, preferred_pharmacy, status, merged_into, created_via, created_at
         FROM patient.patient WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const contacts = await q(
      `SELECT id, patient_id, kind, name, relationship, phone, email, created_at
         FROM patient.patient_contact WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const preferences = await q(
      `SELECT patient_id, channels, reminder_channel, language, quiet_hours, marketing_opt_in, updated_at
         FROM patient.communication_preference WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id`,
    );
    const consents = await q(
      `SELECT id, patient_id, template_key, template_version, template_language, status, signed_at, signer_relationship, signed_name,
              signature_document_id, withdrawn_at, reason, created_at
         FROM patient.consent WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const coverage = await q(
      `SELECT id, patient_id, payer_name, member_id, group_number, front_document_id, back_document_id, eligibility_status, verified_at,
              active, created_at
         FROM patient.insurance_coverage WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    );
    const relationships = await q(
      `SELECT id, patient_id, location_id, reason, started_at, ended_at, ended_reason
         FROM patient.care_relationship WHERE patient_id = ANY($1::uuid[]) ORDER BY started_at, id`,
    );
    const team = await q(
      `SELECT id, patient_id, principal_id, role, from_date, to_date, end_reason
         FROM patient.care_team_member WHERE patient_id = ANY($1::uuid[]) ORDER BY from_date, id`,
    );
    const merges = await q(
      `SELECT merged_id, direct_survivor_id, final_survivor_id, merged_at
         FROM patient.patient_merge WHERE merged_id = ANY($1::uuid[]) ORDER BY merged_at, merged_id`,
    );
    return {
      patients: patients.map((x) => ({
        ...x,
        date_of_birth: iso(x['date_of_birth']),
        created_at: iso(x['created_at']),
      })),
      contacts: contacts.map((x) => ({ ...x, created_at: iso(x['created_at']) })),
      communicationPreferences: preferences.map((x) => ({
        ...x,
        updated_at: iso(x['updated_at']),
      })),
      consents: consents.map((x) => ({
        ...x,
        signed_at: iso(x['signed_at']),
        withdrawn_at: iso(x['withdrawn_at']),
        created_at: iso(x['created_at']),
      })),
      insuranceCoverage: coverage.map((x) => ({
        ...x,
        verified_at: iso(x['verified_at']),
        created_at: iso(x['created_at']),
      })),
      careRelationships: relationships.map((x) => ({
        ...x,
        started_at: iso(x['started_at']),
        ended_at: iso(x['ended_at']),
      })),
      careTeam: team.map((x) => ({
        ...x,
        from_date: iso(x['from_date']),
        to_date: iso(x['to_date']),
      })),
      merges: merges.map((x) => ({ ...x, merged_at: iso(x['merged_at']) })),
    };
  },
};
