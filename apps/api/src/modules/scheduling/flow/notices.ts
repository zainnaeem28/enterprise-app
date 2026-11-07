// Appointment notices (ARCHITECTURE 25.1 steps 6, cancel, reschedule; ticket BE-11, finding INT02-R11-N1): the confirmation, the
// reminders at 48 h and 4 h, the reschedule notice and the cancel notice. The worker's `scheduling.on_reservation_*` handlers call
// these methods inside a patients-scope transaction; every method reads the reservation FIRST, in any status, and answers `gone` when
// the scope cannot see it (its patient was merged: the handler asks for the survivor and runs again). Nothing is sent or cancelled
// before that read succeeds. Confirmation: the recipient is the reservation's patient (a confirmed row is re-pointed by a merge).
// Cancel and reschedule: the merge keeps the cancelled/rescheduled reservation on the merged patient, so the handler passes the
// resolved (survivor) patient as `recipient` and runs in a scope that names both.
//
// Messages are PHI-free (RA-R1-05, BR-23): a date, the location's name, links on the portal host, and the reservation ID as the
// calendar entry's UID. Every send is deduplicated by reservation in the notifications module, so a replayed event sends nothing twice.
import type { Tx } from '@ehr/kernel';
import { isUuid } from '../core/ids.js';
import { SchedulingValidationError } from '../core/errors.js';
import { clock, iso, record } from './common.js';
import type { FlowDeps, Row } from './common.js';
import type { FlowMeta } from './types.js';

/** The offsets that have a template in R1; another configured offset is reported and skipped, never sent with a substitute. */
const REMINDER_TEMPLATES: Readonly<Record<number, string>> = Object.freeze({
  48: 'appointment_reminder_48h',
  4: 'appointment_reminder_4h',
});

export type NoticeOutcome = 'sent' | 'duplicate' | 'skipped' | 'gone';
export interface NoticeResult {
  outcome: NoticeOutcome;
  /** Configured reminder offsets with no template; the job logs them as a configuration error. */
  ignoredOffsets: number[];
}

interface Booking {
  patientId: string;
  locationId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  locationName: string;
}

/** The location's name as the `location_name` variable accepts it: 1-80 characters, no markup or control characters. */
// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u001f\u007f<>{}\\]/g;
const displayName = (n: string): string => {
  const s = n.replace(BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return s.length > 0 ? s : 'Your clinic';
};

export class NoticeService {
  constructor(private readonly deps: FlowDeps) {}

  private async booking(tx: Tx, reservationId: string): Promise<Booking | undefined> {
    if (!isUuid(reservationId)) throw new SchedulingValidationError(['reservationId']);
    const r = await tx.query(
      `SELECT r.patient_id, r.location_id, o.status, lower(o.period) AS starts_at, upper(o.period) AS ends_at,
              l.time_zone, l.name AS location_name
         FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
         JOIN organisation.location l ON l.id = r.location_id
        WHERE r.id = $1::uuid`,
      [reservationId.toLowerCase()],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) return undefined;
    return {
      patientId: String(row['patient_id']).toLowerCase(),
      locationId: String(row['location_id']),
      status: String(row['status']),
      startsAt: new Date(iso(row['starts_at'])),
      endsAt: new Date(iso(row['ends_at'])),
      timeZone: String(row['time_zone']),
      locationName: displayName(String(row['location_name'])),
    };
  }

  private link(path: string): string {
    return new URL(path, this.deps.portalUrl).toString();
  }

  private async audit(tx: Tx, meta: FlowMeta, action: string, id: string, b: Booking) {
    await record(this.deps, tx, meta, {
      action: 'create',
      resourceType: `scheduling.${action}`,
      resourceId: id,
      patientId: b.patientId,
      locationId: b.locationId,
    });
  }

  /** The confirmation/rescheduled message for a confirmed booking, with the `.ics` UID = the reservation ID. */
  private async sendConfirmation(
    tx: Tx,
    templateKey: 'appointment_confirmation' | 'appointment_rescheduled',
    id: string,
    b: Booking,
  ): Promise<boolean> {
    const res = await this.deps.notifications.send(tx, {
      templateKey,
      recipientRef: `patient:${b.patientId}`,
      variables: {
        start_at: b.startsAt.toISOString(),
        end_at: b.endsAt.toISOString(),
        time_zone: b.timeZone,
        location_name: b.locationName,
        portal_link: this.deps.portalUrl,
        event_uid: id,
      },
      dedupeKey: `${templateKey}:${id}`,
    });
    return res.created.length > 0;
  }

  /** Reminders at start minus each configured offset that is still ahead. Returns the offsets with no template. */
  private async scheduleReminders(tx: Tx, id: string, b: Booking): Promise<number[]> {
    const offsets = await this.deps.organisation.setting<number[]>(
      tx,
      'reminder_offsets',
      b.locationId,
    );
    const ignored: number[] = [];
    const now = clock(this.deps).getTime();
    for (const h of offsets) {
      const templateKey = REMINDER_TEMPLATES[h];
      if (templateKey === undefined) {
        ignored.push(h);
        continue;
      }
      const at = new Date(b.startsAt.getTime() - h * 3_600_000);
      if (at.getTime() <= now) continue;
      await this.deps.notifications.send(tx, {
        templateKey,
        recipientRef: `patient:${b.patientId}`,
        variables: {
          start_at: b.startsAt.toISOString(),
          time_zone: b.timeZone,
          portal_link: this.deps.portalUrl,
          confirm_link: this.link(`appointments/${id}`),
          reschedule_link: this.link(`appointments/${id}/change`),
          cancel_link: this.link(`appointments/${id}/cancel`),
        },
        dedupeKey: `reminder:${id}:${h}h`,
        sendAfter: at,
      });
    }
    return ignored;
  }

  /** `scheduling.on_reservation_confirmed` (4.1): the confirmation and the reminders. */
  async confirmed(tx: Tx, meta: FlowMeta, reservationId: string): Promise<NoticeResult> {
    const id = reservationId.toLowerCase();
    const b = await this.booking(tx, id);
    if (b === undefined) return { outcome: 'gone', ignoredOffsets: [] };
    if (b.status !== 'confirmed') return { outcome: 'skipped', ignoredOffsets: [] };
    const created = await this.sendConfirmation(tx, 'appointment_confirmation', id, b);
    const ignoredOffsets = await this.scheduleReminders(tx, id, b);
    if (created) await this.audit(tx, meta, 'appointment_notice', id, b);
    return { outcome: created ? 'sent' : 'duplicate', ignoredOffsets };
  }

  /**
   * `scheduling.on_reservation_cancelled` (4.2): the reminders are cancelled; a booking that was confirmed gets the cancel notice.
   * `recipient` is the patient the handler resolved (the survivor after a merge): a cancelled or rescheduled reservation is KEPT by
   * the merge (scheduling/core/merge.ts, rule K), so it still names the merged patient, while its queued reminders were re-pointed.
   */
  async cancelled(
    tx: Tx,
    meta: FlowMeta,
    reservationId: string,
    wasConfirmed: boolean,
    recipient: string,
  ): Promise<NoticeResult> {
    const id = reservationId.toLowerCase();
    const b = await this.booking(tx, id);
    if (b === undefined) return { outcome: 'gone', ignoredOffsets: [] };
    await this.deps.notifications.cancel(tx, `reminder:${id}`);
    if (!wasConfirmed) return { outcome: 'skipped', ignoredOffsets: [] };
    const res = await this.deps.notifications.send(tx, {
      templateKey: 'appointment_cancelled',
      recipientRef: `patient:${recipient.toLowerCase()}`,
      variables: { portal_link: this.deps.portalUrl },
      dedupeKey: `appointment_cancelled:${id}`,
    });
    if (res.created.length > 0)
      await this.audit(tx, meta, 'appointment_notice', id, {
        ...b,
        patientId: recipient.toLowerCase(),
      });
    return { outcome: res.created.length > 0 ? 'sent' : 'duplicate', ignoredOffsets: [] };
  }

  /**
   * `scheduling.on_reservation_rescheduled` (4.3): the old reservation's reminders are cancelled; the new reservation, if it still
   * stands, gets the rescheduled notice and its own reminders. The caller then schedules the new pre-visit invitation.
   */
  async rescheduled(
    tx: Tx,
    meta: FlowMeta,
    reservationId: string,
    newReservationId: string,
    recipient: string,
  ): Promise<NoticeResult> {
    const id = reservationId.toLowerCase();
    const nid = newReservationId.toLowerCase();
    const old = await this.booking(tx, id);
    if (old === undefined) return { outcome: 'gone', ignoredOffsets: [] };
    const n0 = await this.booking(tx, nid);
    const next = n0 === undefined ? undefined : { ...n0, patientId: recipient.toLowerCase() };
    await this.deps.notifications.cancel(tx, `reminder:${id}`);
    if (next === undefined || next.status !== 'confirmed')
      return { outcome: 'skipped', ignoredOffsets: [] };
    const created = await this.sendConfirmation(tx, 'appointment_rescheduled', nid, next);
    const ignoredOffsets = await this.scheduleReminders(tx, nid, next);
    if (created) await this.audit(tx, meta, 'appointment_notice', nid, next);
    return { outcome: created ? 'sent' : 'duplicate', ignoredOffsets };
  }
}
