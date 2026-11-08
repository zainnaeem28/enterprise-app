// The unsigned-note reminder (ARCHITECTURE 33.1 `clinical.note_sign_reminder`, 22.13 alert type `note_unsigned`; TC-CL-06).
// Runs in the worker's transaction under a patients-scope system job. It raises ONE alert per run to the encounter's clinician (and to
// the author of any draft left on the encounter) unless the encounter already has a note signed or submitted for co-signature. The alert
// row holds IDs only (the encounter, the patient, the place): no name, no note text, so the reminder carries no PHI (RA-R1-19).
//
// A job that finds nothing it may read ends without writing: the encounter is not visible to this job when the patient was merged after
// the encounter was completed (a completed encounter is a K row and stays on the merged ID, 22.16, while the job resolved to the
// survivor). That is the documented limitation in the module README.
import type { Tx } from '@ehr/kernel';
import { isUuid } from '../chart/ids.js';
import type { Row } from '../frontdoor/common.js';
import { NotesValidationError } from './errors.js';
import type { NoteAlertPort } from './ports.js';

export type ReminderOutcome =
  | { outcome: 'raised'; alertId: string }
  | { outcome: 'skipped'; reason: 'not_visible' | 'not_completed' | 'note_present' };

export class NoteReminderService {
  constructor(private readonly deps: { alerts: NoteAlertPort }) {}

  async run(
    tx: Tx,
    payload: { encounterId?: unknown; patientId?: unknown },
  ): Promise<ReminderOutcome> {
    if (!isUuid(payload.encounterId) || !isUuid(payload.patientId))
      throw new NotesValidationError(['encounterId', 'patientId']);
    const enc = (
      await tx.query(
        `SELECT id, patient_id, location_id, clinician_principal_id, status FROM clinical.encounter WHERE id = $1::uuid`,
        [payload.encounterId.toLowerCase()],
      )
    ).rows[0] as Row | undefined;
    if (enc === undefined) return { outcome: 'skipped', reason: 'not_visible' };
    if (enc['status'] !== 'completed') return { outcome: 'skipped', reason: 'not_completed' };
    const notes = (
      await tx.query(
        `SELECT status, author_principal_id FROM clinical.note WHERE encounter_id = $1::uuid`,
        [String(enc['id'])],
      )
    ).rows as Row[];
    if (notes.some((n) => n['status'] === 'signed' || n['status'] === 'pending_cosign'))
      return { outcome: 'skipped', reason: 'note_present' };
    const targets = [
      ...new Set([
        String(enc['clinician_principal_id']),
        ...notes.map((n) => String(n['author_principal_id'])),
      ]),
    ].sort();
    const raised = await this.deps.alerts.raise(tx, {
      type: 'note_unsigned',
      severity: 'medium',
      targets: { kind: 'principal', principalIds: targets },
      resourceType: 'encounter',
      resourceId: String(enc['id']),
      patientId: String(enc['patient_id']),
      locationId: String(enc['location_id']),
    });
    return { outcome: 'raised', alertId: raised.alertId };
  }
}
