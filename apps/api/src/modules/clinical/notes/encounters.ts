// Encounters (ARCHITECTURE 22.11, 23.1, 23.2, 25.5; PRD RA-R1-08, RA-R1-09; ST-01).
//
//   POST /encounters                 start a consultation from a checked-in reservation: the consent gate (BR-09), the encounter row,
//                                    the occupancy `checked_in -> in_consultation`, all in one transaction
//   POST /encounters/{id}/complete   `in_consultation -> completed` with a note signed (or submitted for co-signature) or the deferral
//                                    recorded (ST-01); the occupancy `-> completed`; a deferral schedules the 24 h reminder
//
// Lock order (25.2): the patient (key_share) first, then the encounter / occupancy rows. The transaction reads before it locks and
// calls `lockPatients` once.
import type { Tx } from '@ehr/kernel';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { isUuid, uuidv7 } from '../chart/ids.js';
import { iso, isoOrNull, strOrNull } from '../frontdoor/common.js';
import type { Row } from '../frontdoor/common.js';
import type { ConsentGateService } from '../frontdoor/consents.js';
import {
  InvalidTransitionError,
  NoteUnsignedError,
  NotesNotFoundError,
  NotesScopeError,
  NotesValidationError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
import type { NotesPorts } from './ports.js';
import { NOTE_SIGN_DEADLINE_HOURS, hoursSetting } from './settings.js';
import type { EncounterView, RequestMeta, StartedEncounter } from './types.js';

export const NOTE_SIGN_REMINDER_JOB = 'clinical.note_sign_reminder';
export const MIN_DEFER_REASON = 10;
export const MAX_DEFER_REASON = 500;

export interface EncounterDeps {
  audit: ChartAuditPort;
  gate: Pick<ConsentGateService, 'start'>;
  ports: Pick<NotesPorts, 'reservations' | 'jobs'>;
  now?: () => Date;
}

export function toEncounterView(r: Row): EncounterView {
  return {
    id: String(r['id']),
    patientId: String(r['patient_id']),
    locationId: String(r['location_id']),
    reservationId: strOrNull(r['reservation_id']),
    clinicianPrincipalId: String(r['clinician_principal_id']),
    mode: r['mode'] === 'video' ? 'video' : 'in_person',
    status: r['status'] as EncounterView['status'],
    startedAt: isoOrNull(r['started_at']),
    endedAt: isoOrNull(r['ended_at']),
    noteDeferredReason: strOrNull(r['note_deferred_reason']),
    version: Number(r['row_version']),
  };
}

const staffId = (tx: Tx): string => {
  const p = tx.scope.principalId;
  if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
    throw new NotesNotFoundError();
  return p;
};

export class EncounterService {
  constructor(private readonly deps: EncounterDeps) {}

  async get(tx: Tx, id: string): Promise<Row | undefined> {
    if (!isUuid(id)) return undefined;
    return (
      await tx.query(`SELECT * FROM clinical.encounter WHERE id = $1::uuid`, [id.toLowerCase()])
    ).rows[0] as Row | undefined;
  }

  /**
   * `POST /encounters` (Idem). The caller is the reservation's clinician, at a location where they hold the permission; the visit is
   * checked in (23.1). Missing required consents refuse with `409 clinical.consents_missing` and nothing is written, unless an
   * emergency exception with a reason is given (then one exception row is recorded, BR-09).
   */
  async start(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    input: { reservationId: unknown; emergencyException?: unknown },
  ): Promise<StartedEncounter> {
    const principal = staffId(tx);
    if (!isUuid(input.reservationId)) throw new NotesValidationError(['reservationId']);
    const ex = input.emergencyException;
    if (ex !== undefined && (ex === null || typeof ex !== 'object' || Array.isArray(ex)))
      throw new NotesValidationError(['emergencyException']);
    const res = await this.deps.ports.reservations.get(tx, input.reservationId.toLowerCase());
    if (res === undefined) throw new NotesNotFoundError();
    if (
      res.clinicianPrincipalId !== principal ||
      !ctx.grants.has('clinical.consultation.start', res.locationId)
    )
      throw new NotesScopeError();
    try {
      await tx.lockPatients([res.patientId], 'key_share');
      if (
        (
          await tx.query(`SELECT 1 FROM clinical.encounter WHERE reservation_id = $1::uuid`, [
            res.reservationId,
          ])
        ).rows.length > 0
      )
        throw new InvalidTransitionError();
      // Re-read after the lock: the status the consultation starts from is checked_in (a retry finds the encounter above).
      const cur = await this.deps.ports.reservations.get(tx, res.reservationId);
      if (cur === undefined) throw new NotesNotFoundError();
      if (cur.occupancyStatus !== 'checked_in') throw new InvalidTransitionError();

      const id = uuidv7();
      const gate = await this.deps.gate.start(tx, meta, {
        encounterId: id,
        patientId: cur.patientId,
        serviceId: cur.serviceId,
        emergencyException: ex as { reason?: unknown } | undefined,
      });
      const inserted = await tx.query(
        `INSERT INTO clinical.encounter (id, organisation_id, patient_id, location_id, reservation_id, clinician_principal_id, mode, status, started_at, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'in_consultation', now(), $5::uuid)
         RETURNING *`,
        [id, cur.patientId, cur.locationId, cur.reservationId, principal, cur.mode],
      );
      await this.deps.ports.reservations.startConsultation(tx, cur.reservationId);
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'clinical.encounter',
        resourceId: id,
        patientId: cur.patientId,
        locationId: cur.locationId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: {
          reservationId: cur.reservationId,
          mode: cur.mode,
          consentException: gate.exceptionId !== undefined,
        },
      });
      return {
        encounter: toEncounterView(inserted.rows[0] as Row),
        consentExceptionId: gate.exceptionId ?? null,
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /encounters/{id}/complete` (Idem, If-Match). `409 clinical.note_unsigned` unless the encounter has a note signed or submitted
   * for co-signature, or `deferNoteReason` (10..500 characters) is given. A deferral schedules `clinical.note_sign_reminder` for
   * `note_sign_deadline_hours` after the end (33.1).
   */
  async complete(
    tx: Tx,
    meta: RequestMeta,
    id: string,
    expectedVersion: number,
    input: { deferNoteReason?: unknown },
  ): Promise<EncounterView> {
    const principal = staffId(tx);
    let reason: string | undefined;
    if (input.deferNoteReason !== undefined && input.deferNoteReason !== null) {
      const t = typeof input.deferNoteReason === 'string' ? input.deferNoteReason.trim() : '';
      if (t.length < MIN_DEFER_REASON || t.length > MAX_DEFER_REASON)
        throw new NotesValidationError(['deferNoteReason']);
      reason = t;
    }
    const first = await this.get(tx, id);
    if (first === undefined) throw new NotesNotFoundError();
    if (String(first['clinician_principal_id']) !== principal) throw new NotesScopeError();
    try {
      await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const cur = (
        await tx.query(`SELECT * FROM clinical.encounter WHERE id = $1::uuid FOR UPDATE`, [
          String(first['id']),
        ])
      ).rows[0] as Row | undefined;
      if (cur === undefined) throw new NotesNotFoundError();
      if (String(cur['clinician_principal_id']) !== principal) throw new NotesScopeError();
      if (Number(cur['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      if (cur['status'] !== 'in_consultation') throw new InvalidTransitionError();
      const hasNote =
        (
          await tx.query(
            `SELECT 1 FROM clinical.note WHERE encounter_id = $1::uuid AND status IN ('signed', 'pending_cosign') LIMIT 1`,
            [String(cur['id'])],
          )
        ).rows.length > 0;
      if (!hasNote && reason === undefined) throw new NoteUnsignedError();
      const updated = (
        await tx.query(
          `UPDATE clinical.encounter SET status = 'completed', ended_at = now(), note_deferred_reason = $2
            WHERE id = $1::uuid RETURNING *`,
          [String(cur['id']), hasNote ? null : (reason ?? null)],
        )
      ).rows[0] as Row;
      if (cur['reservation_id'] !== null && cur['reservation_id'] !== undefined)
        await this.deps.ports.reservations.completeConsultation(tx, String(cur['reservation_id']));
      if (!hasNote) {
        const hours = await hoursSetting(tx, NOTE_SIGN_DEADLINE_HOURS);
        const ended = new Date(iso(updated['ended_at']));
        await this.deps.ports.jobs.enqueue(
          tx,
          NOTE_SIGN_REMINDER_JOB,
          { encounterId: String(updated['id']), patientId: String(updated['patient_id']) },
          {
            runAt: new Date(ended.getTime() + hours * 3_600_000),
            jobKey: `note_sign_reminder:${String(updated['id'])}`,
          },
        );
      }
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'clinical.encounter',
        resourceId: String(updated['id']),
        patientId: String(updated['patient_id']),
        locationId: String(updated['location_id']),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: 'completed', noteDeferred: !hasNote },
      });
      return toEncounterView(updated);
    } catch (e) {
      translateDbError(e);
    }
  }
}
