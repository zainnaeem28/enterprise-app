// The ports of ports.ts over the real services of the other modules (the composition root calls `createNotesPorts`; the tests do too,
// so what they exercise is the code that ships).
import type { Queue, Tx } from '@ehr/kernel';
import type { Row } from '../frontdoor/common.js';
import type { NoteAlertInput, NotesPorts } from './ports.js';

export interface NotesPortDeps {
  alerts: { raise(tx: Tx, input: NoteAlertInput): Promise<{ alertId: string }> };
  queue: Pick<Queue, 'publish' | 'enqueue'>;
}

export function createNotesPorts(d: NotesPortDeps): NotesPorts {
  return {
    reservations: {
      async get(tx, id) {
        const r = await tx.query(
          `SELECT r.id, r.patient_id, r.location_id, r.service_id, r.clinician_principal_id, r.mode, o.status
             FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
            WHERE r.id = $1::uuid`,
          [id],
        );
        const x = r.rows[0] as Row | undefined;
        if (x === undefined) return undefined;
        return {
          reservationId: String(x['id']),
          patientId: String(x['patient_id']),
          locationId: String(x['location_id']),
          serviceId: String(x['service_id']),
          clinicianPrincipalId: String(x['clinician_principal_id']),
          mode: x['mode'] === 'video' ? 'video' : 'in_person',
          occupancyStatus: String(x['status']),
        };
      },
      async startConsultation(tx, id) {
        await tx.query(`SELECT scheduling.set_status($1::uuid, 'checked_in', 'in_consultation')`, [
          id,
        ]);
      },
      async completeConsultation(tx, id) {
        await tx.query(`SELECT scheduling.set_status($1::uuid, 'in_consultation', 'completed')`, [
          id,
        ]);
      },
    },
    alerts: { raise: (tx, input) => d.alerts.raise(tx, input) },
    events: { publish: (tx, event, payload) => d.queue.publish(tx, event, payload) },
    jobs: {
      enqueue: (tx, name, payload, opts) =>
        d.queue.enqueue(tx, name, payload, { runAt: opts.runAt, jobKey: opts.jobKey }),
    },
  };
}
