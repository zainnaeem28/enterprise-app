// What the clinical front door's and notes' worker handlers need from the API's services (the worker cannot import the API package;
// `apps/api/src/worker-ports.ts` implements this over the real services). Each method takes the transaction the handler opened: the
// handler decides the scope (one patient), the service does the work.
import type { Tx } from '@ehr/kernel';

export interface ClinicalWorkerPort {
  /** `TriageService.retargetUnacknowledged`: the principals added (empty: nobody on call, or the alert is not a red flag). */
  retargetUnacknowledged(tx: Tx, alertId: string): Promise<string[]>;
  /** `runNoteSignReminder`: raises the `note_unsigned` alert unless a note was signed or submitted meanwhile. */
  noteSignReminder(tx: Tx, payload: { encounterId: string; patientId: string }): Promise<unknown>;
}
