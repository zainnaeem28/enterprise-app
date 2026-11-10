// The scheduling flow (ARCHITECTURE 25.5, 22.8, 29.3, 29.2; ticket BE-13): check-in (desk and QR), the arrivals board, the queue,
// the no-show decision and the no-show sweep. Waitlist and pre-visit are in waitlist.ts and previsit.ts.
//
// Every method runs in the caller's scoped transaction, so row-level security is the second line after the guard. The invariants are
// the database's (migrations 1300-1302): which moves a queue entry may make, that a check-in belongs to its reservation and only
// exists while the visit is checked in, that a finished row is never written again. Lock order (25.2): the patient root first
// (`lockPatients`, once, at the start of a transaction that writes), then the rows.
//
//   * Check-in moves the occupancy `confirmed -> checked_in` through `scheduling.set_status` (the definer function that owns that
//     table), then inserts the check-in and the queue entry in the same transaction. The patient (QR) and staff (desk) paths differ
//     only in who may take the step and in the QR token.
//   * The queue is first in, first out by arrival (PM-confirm-2: ordering by category is not asserted). Category and wait time are
//     returned for every entry; nobody is dropped.
import type { Tx } from '@ehr/kernel';
import { isUuid } from '../core/ids.js';
import { ACTIVE_STATUSES } from '../core/service.js';
import {
  InvalidTransitionError,
  PreconditionFailedError,
  ReservationNotFoundError,
  SchedulingScopeError,
  SchedulingValidationError,
  SlotTakenError,
  translateDbError,
} from '../core/errors.js';
import { CheckInNotAllowedError, GraceNotElapsedError } from './errors.js';
import { clock, graceMinutes, iso, isoOrNull, localDate, record } from './common.js';
import type { FlowDeps, Row } from './common.js';
import { NoticeService } from './notices.js';
import { PrevisitService } from './previsit.js';
import { qrToken, qrTokenMatches } from './qr.js';
import { WaitlistService } from './waitlist.js';
import { QUEUE_STAGES, TRIAGE_CATEGORIES } from './types.js';
import type {
  ArrivalView,
  CheckInMethod,
  ClinicianScheduleItem,
  CheckInResult,
  FlowMeta,
  NoShowCandidate,
  Previsit,
  PrevisitConsentsOpened,
  PrevisitView,
  QueueEntryView,
  QueueStage,
  TriageCategory,
} from './types.js';

const APPT_SQL = `
  SELECT r.id, r.patient_id, r.location_id, r.service_id, r.clinician_principal_id, r.mode, o.status,
         lower(o.period) AS starts_at, upper(o.period) AS ends_at, (r.row_version + o.row_version) AS version, l.time_zone
    FROM scheduling.slot_reservation r
    JOIN scheduling.slot_occupancy o ON o.id = r.id
    JOIN organisation.location l ON l.id = r.location_id
   WHERE r.id = $1::uuid`;

const name = (r: Row): string | null =>
  r['given_name'] === null || r['given_name'] === undefined
    ? null
    : `${String(r['given_name'])} ${String(r['family_name'] ?? '')}`.trim();

const toQueueView = (r: Row, now: Date): QueueEntryView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  patientName: name(r),
  stage: r['stage'] as QueueStage,
  triageCategory: (r['triage_category'] as TriageCategory | null) ?? null,
  enteredAt: iso(r['entered_at']),
  stageChangedAt: iso(r['stage_changed_at']),
  waitSeconds: Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso(r['entered_at'])).getTime()) / 1000),
  ),
  assignedClinicianId:
    r['assigned_clinician_principal_id'] === null
      ? null
      : String(r['assigned_clinician_principal_id']),
  roomId: r['room_id'] === null ? null : String(r['room_id']),
  version: Number(r['row_version']),
});

/** The clinician predicate of the own-schedule read (decision HEAAA-286): in the `WHERE` clause, not a post-filter. */
export const CLINICIAN_PREDICATE = 'AND r.clinician_principal_id = $3::uuid';

/** The arrivals query; with `ownClinician` it also carries {@link CLINICIAN_PREDICATE} (parameter `$3`). */
export const arrivalsSql = (ownClinician: boolean): string =>
  `SELECT r.id, r.patient_id, r.service_id, r.clinician_principal_id, r.mode, o.status, lower(o.period) AS starts_at,
              upper(o.period) AS ends_at, (r.row_version + o.row_version) AS version, ci.checked_in_at, ci.method, q.stage,
              (f.reservation_id IS NOT NULL) AS flagged, p.given_name, p.family_name, p.mrn
         FROM scheduling.slot_reservation r
         JOIN scheduling.slot_occupancy o ON o.id = r.id
         JOIN organisation.location l ON l.id = r.location_id
         LEFT JOIN scheduling.check_in ci ON ci.id = r.id
         LEFT JOIN scheduling.queue_entry q ON q.id = r.id
         LEFT JOIN scheduling.no_show_flag f ON f.reservation_id = r.id
         LEFT JOIN patient.patient p ON p.id = r.patient_id
        WHERE r.location_id = $1::uuid
          AND o.status IN ('confirmed', 'checked_in', 'in_consultation', 'completed', 'no_show')
          AND (lower(o.period) AT TIME ZONE l.time_zone)::date = $2::date
          ${ownClinician ? CLINICIAN_PREDICATE : ''}
        ORDER BY lower(o.period), r.id LIMIT 500`;

export class SchedulingFlowService {
  readonly waitlist: WaitlistService;
  readonly previsit: PrevisitService;
  readonly notices: NoticeService;

  /** The audit service, for the controller's own-only refusal (a property read, not a call into the flow). */
  readonly audit: FlowDeps['audit'];

  constructor(private readonly deps: FlowDeps) {
    this.audit = deps.audit;
    this.previsit = new PrevisitService(deps);
    this.notices = new NoticeService(deps);
    this.waitlist = new WaitlistService(deps);
  }

  private now(): Date {
    return clock(this.deps);
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (p === undefined) throw new SchedulingScopeError();
    return p;
  }

  private staffLocations(tx: Tx): string[] {
    return (tx.scope.locationIds ?? []).map((x) => x.toLowerCase());
  }

  // ===== QR token (22.8 note) ==========================================================================================

  /** `GET /locations/{id}/check-in-qr`: today's token for a location of the caller. */
  async qrForToday(tx: Tx, locationId: string): Promise<{ token: string; localDate: string }> {
    if (!isUuid(locationId)) throw new SchedulingValidationError(['locationId']);
    if (
      tx.scope.audience !== 'staff' ||
      !this.staffLocations(tx).includes(locationId.toLowerCase())
    )
      throw new SchedulingScopeError();
    const day = await localDate(tx, locationId.toLowerCase(), this.now());
    if (day === undefined) throw new ReservationNotFoundError();
    return {
      token: qrToken(await this.deps.qrKey.current(), locationId, day.date),
      localDate: day.date,
    };
  }

  // ===== check-in (25.5) ===============================================================================================

  /**
   * Check a visit in. `desk`: a staff caller (permission `scheduling.check_in`, checked by the guard) at a location of theirs. `qr`: a
   * patient or proxy session with the token for that location and the local day. Allowed only for an in-person visit that is
   * `confirmed`, at the visit's own location, on the visit's own local day; everything else, and a wrong or stale token, is
   * `422 scheduling.check_in_not_allowed`. Repeating it on a visit that is already checked in changes nothing and returns the same result.
   */
  async checkIn(
    tx: Tx,
    meta: FlowMeta,
    reservationId: string,
    o: { method: CheckInMethod; qrToken?: string; expectedVersion?: number },
  ): Promise<CheckInResult> {
    if (!isUuid(reservationId)) throw new SchedulingValidationError(['reservationId']);
    const audience = tx.scope.audience;
    if (
      (o.method === 'desk') !== (audience === 'staff') ||
      (o.method === 'qr' && audience !== 'patient')
    )
      throw new SchedulingScopeError();
    const principal = this.principal(tx);
    const id = reservationId.toLowerCase();

    const first = (await tx.query(APPT_SQL, [id])).rows[0] as Row | undefined;
    if (first === undefined) throw new ReservationNotFoundError();
    if (o.expectedVersion !== undefined && o.expectedVersion !== Number(first['version']))
      throw new PreconditionFailedError();
    const locationId = String(first['location_id']);
    if (audience === 'staff' && !this.staffLocations(tx).includes(locationId.toLowerCase()))
      throw new SchedulingScopeError();
    const patientId = String(first['patient_id']);

    try {
      await tx.lockPatients([patientId], 'key_share');
      // Check-ins of one visit (a desk and a QR at the same moment, a retry) take turns here, so the loser finds the result of the winner.
      // The reservation row first, the occupancy row second (inside set_status): the same order as a cancel, which writes the reservation first.
      await tx.query(`SELECT 1 FROM scheduling.slot_reservation WHERE id = $1::uuid FOR UPDATE`, [
        id,
      ]);
      const cur = (await tx.query(APPT_SQL, [id])).rows[0] as Row | undefined;
      if (cur === undefined) throw new ReservationNotFoundError();

      // Already checked in: the same answer again (a retry, a second tap on the QR).
      if (cur['status'] === 'checked_in') {
        const existing = await this.readCheckIn(tx, id);
        if (existing !== undefined) return { ...existing, alreadyCheckedIn: true };
      }
      if (o.expectedVersion !== undefined && o.expectedVersion !== Number(cur['version']))
        throw new PreconditionFailedError();
      if (cur['status'] !== 'confirmed' || cur['mode'] !== 'in_person')
        throw new CheckInNotAllowedError();

      const now = this.now();
      const today = await localDate(tx, locationId, now);
      const visitDay = await localDate(tx, locationId, new Date(iso(cur['starts_at'])));
      if (today === undefined || visitDay === undefined || today.date !== visitDay.date)
        throw new CheckInNotAllowedError();
      if (o.method === 'qr') {
        const expected = qrToken(await this.deps.qrKey.current(), locationId, today.date);
        if (!qrTokenMatches(o.qrToken, expected)) throw new CheckInNotAllowedError();
      }

      await tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'checked_in')`, [id]);
      const previsit = await this.previsit.status(tx, patientId, String(cur['service_id']), id);
      await tx.query(
        `INSERT INTO scheduling.check_in (id, organisation_id, patient_id, location_id, method, by_principal_id, previsit_status, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, $5::uuid, $6::jsonb, $5::uuid)`,
        [id, patientId, locationId, o.method, principal, JSON.stringify(previsit)],
      );
      await tx.query(
        `INSERT INTO scheduling.queue_entry (id, organisation_id, patient_id, location_id, stage, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, 'waiting', $4::uuid)`,
        [id, patientId, locationId, principal],
      );
      await record(this.deps, tx, meta, {
        action: 'create',
        resourceType: 'scheduling.check_in',
        resourceId: id,
        patientId,
        locationId,
        change: { method: o.method },
      });
      await this.deps.queue?.publish(tx, 'scheduling.checked_in', { reservationId: id, patientId });
      const out = await this.readCheckIn(tx, id);
      if (out === undefined) throw new InvalidTransitionError();
      return { ...out, previsit, alreadyCheckedIn: false };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** The check-in as the caller sees it. The queue entry's ID is the reservation ID (22.8), so a patient, who cannot read the queue, still gets it. */
  private async readCheckIn(
    tx: Tx,
    id: string,
  ): Promise<Omit<CheckInResult, 'alreadyCheckedIn'> | undefined> {
    const r = (
      await tx.query(
        `SELECT id, patient_id, location_id, method, checked_in_at, previsit_status FROM scheduling.check_in WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0] as Row | undefined;
    if (r === undefined) return undefined;
    return {
      reservationId: String(r['id']),
      patientId: String(r['patient_id']),
      locationId: String(r['location_id']),
      method: r['method'] as CheckInMethod,
      checkedInAt: iso(r['checked_in_at']),
      queueEntryId: String(r['id']),
      previsit: r['previsit_status'] as Previsit,
    };
  }

  // ===== arrivals board (29.3) =========================================================================================

  /** `GET /locations/{id}/arrivals?date`: the day's visits at a location, with who has arrived, who is late, and the pre-visit flags. */
  async arrivals(tx: Tx, locationId: string, date?: string): Promise<ArrivalView[]> {
    if (!isUuid(locationId)) throw new SchedulingValidationError(['locationId']);
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new SchedulingValidationError(['date']);
    const loc = locationId.toLowerCase();
    const now = this.now();
    const today = await localDate(tx, loc, now);
    if (today === undefined) throw new ReservationNotFoundError();
    const day = date ?? today.date;
    const r = await tx.query(arrivalsSql(false), [loc, day]);
    const graces = new Map<string, number>();
    const out: ArrivalView[] = [];
    for (const x of r.rows as Row[]) {
      const key = `${String(x['service_id'])}:${String(x['mode'])}`;
      let g = graces.get(key);
      if (g === undefined) {
        g = graceMinutes(
          await this.deps.organisation.bookingPolicy(tx, String(x['service_id']), loc),
          String(x['mode']),
        );
        graces.set(key, g);
      }
      const status = String(x['status']);
      const startsAt = iso(x['starts_at']);
      const live = status === 'confirmed' || status === 'checked_in';
      out.push({
        reservationId: String(x['id']),
        patientId: String(x['patient_id']),
        patientName: name(x),
        mrn: x['mrn'] === null || x['mrn'] === undefined ? null : String(x['mrn']),
        serviceId: String(x['service_id']),
        clinicianId: String(x['clinician_principal_id']),
        mode: x['mode'] as 'in_person' | 'video',
        status,
        startsAt,
        endsAt: iso(x['ends_at']),
        checkedInAt: isoOrNull(x['checked_in_at']),
        method: (x['method'] as CheckInMethod | null) ?? null,
        queueStage: (x['stage'] as QueueStage | null) ?? null,
        previsit: live
          ? await this.previsit.status(
              tx,
              String(x['patient_id']),
              String(x['service_id']),
              String(x['id']),
            )
          : null,
        noShowCandidate:
          status === 'confirmed' && now.getTime() >= new Date(startsAt).getTime() + g * 60_000,
        flaggedForStaff: x['flagged'] === true,
        version: Number(x['version']),
      });
    }
    return out;
  }

  /**
   * `GET /clinicians/{id}/schedule?locationId&date` (draft 8.3, FE-10): the clinician's own reservations of one location-day. The same
   * query as `arrivals` plus the clinician predicate; no pre-visit lookups; only the fields of `ClinicianScheduleItem`. Audited as one
   * `view` with the patient IDs returned (at most the 500 rows of the query).
   */
  async clinicianSchedule(
    tx: Tx,
    meta: FlowMeta,
    clinicianId: string,
    locationId: string,
    date?: string,
  ): Promise<{ items: ClinicianScheduleItem[]; timeZone: string }> {
    if (!isUuid(locationId)) throw new SchedulingValidationError(['locationId']);
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new SchedulingValidationError(['date']);
    const loc = locationId.toLowerCase();
    const today = await localDate(tx, loc, this.now());
    if (today === undefined) throw new ReservationNotFoundError();
    const day = date ?? today.date;
    const r = await tx.query(arrivalsSql(true), [loc, day, clinicianId.toLowerCase()]);
    const items: ClinicianScheduleItem[] = (r.rows as Row[]).map((x) => ({
      reservationId: String(x['id']),
      patientId: String(x['patient_id']),
      patientName: name(x),
      mrn: x['mrn'] === null || x['mrn'] === undefined ? null : String(x['mrn']),
      serviceId: String(x['service_id']),
      mode: x['mode'] as 'in_person' | 'video',
      status: String(x['status']) as ClinicianScheduleItem['status'],
      startsAt: iso(x['starts_at']),
      endsAt: iso(x['ends_at']),
      checkedInAt: isoOrNull(x['checked_in_at']),
      queueStage: (x['stage'] as QueueStage | null) ?? null,
    }));
    await record(this.deps, tx, meta, {
      action: 'view',
      resourceType: 'scheduling.reservation',
      locationId: loc,
      change: { patientIds: [...new Set(items.map((i) => i.patientId))] },
    });
    return { items, timeZone: today.timeZone };
  }

  // ===== queue (29.3) ==================================================================================================

  /** `GET /locations/{id}/queue`: waiting, in first-in-first-out order, with stage, category and wait time. `done` entries leave the list. */
  async queue(tx: Tx, locationId: string): Promise<QueueEntryView[]> {
    if (!isUuid(locationId)) throw new SchedulingValidationError(['locationId']);
    const r = await tx.query(
      `SELECT q.id, q.patient_id, q.stage, q.triage_category, q.entered_at, q.stage_changed_at,
              q.assigned_clinician_principal_id, q.room_id, q.row_version, p.given_name, p.family_name
         FROM scheduling.queue_entry q LEFT JOIN patient.patient p ON p.id = q.patient_id
        WHERE q.location_id = $1::uuid AND q.stage <> 'done' ORDER BY q.entered_at, q.id LIMIT 500`,
      [locationId.toLowerCase()],
    );
    const now = this.now();
    return (r.rows as Row[]).map((x) => toQueueView(x, now));
  }

  private async readEntry(tx: Tx, id: string): Promise<QueueEntryView | undefined> {
    const r = await tx.query(
      `SELECT q.id, q.patient_id, q.stage, q.triage_category, q.entered_at, q.stage_changed_at,
              q.assigned_clinician_principal_id, q.room_id, q.row_version, p.given_name, p.family_name
         FROM scheduling.queue_entry q LEFT JOIN patient.patient p ON p.id = q.patient_id WHERE q.id = $1::uuid`,
      [id],
    );
    return r.rows[0] === undefined ? undefined : toQueueView(r.rows[0] as Row, this.now());
  }

  /** `PUT /queue-entries/{id}/stage` (If-Match). Any stage but the current one, and nothing after `done` (the trigger of 1301 is the authority). */
  async setStage(
    tx: Tx,
    meta: FlowMeta,
    entryId: string,
    stage: unknown,
    expectedVersion: number,
  ): Promise<QueueEntryView> {
    if (!isUuid(entryId)) throw new ReservationNotFoundError();
    if (typeof stage !== 'string' || !(QUEUE_STAGES as readonly string[]).includes(stage))
      throw new SchedulingValidationError(['stage']);
    const first = await this.readEntry(tx, entryId.toLowerCase());
    if (first === undefined) throw new ReservationNotFoundError();
    if (first.version !== expectedVersion) throw new PreconditionFailedError();
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      const cur = await this.readEntry(tx, first.id);
      if (cur === undefined) throw new ReservationNotFoundError();
      if (cur.version !== expectedVersion) throw new PreconditionFailedError();
      if (cur.stage === 'done' || cur.stage === stage) throw new InvalidTransitionError();
      const u = await tx.query(
        `UPDATE scheduling.queue_entry SET stage = $2 WHERE id = $1::uuid AND row_version = $3 RETURNING id`,
        [cur.id, stage, expectedVersion],
      );
      if (u.rows.length === 0) throw new PreconditionFailedError();
      await this.auditEntry(tx, meta, cur, { stage });
      return (await this.readEntry(tx, cur.id)) as QueueEntryView;
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * The triage category of a queue entry (22.8 `triage_category`). The triage save of the clinical module (BE-18) calls this in its own
   * transaction; there is no route here. Re-triage overwrites it (the assessment history is the clinical module's, append-only).
   */
  async setTriageCategory(
    tx: Tx,
    meta: FlowMeta,
    entryId: string,
    category: unknown,
  ): Promise<QueueEntryView> {
    if (!isUuid(entryId)) throw new ReservationNotFoundError();
    if (
      typeof category !== 'string' ||
      !(TRIAGE_CATEGORIES as readonly string[]).includes(category)
    )
      throw new SchedulingValidationError(['category']);
    const first = await this.readEntry(tx, entryId.toLowerCase());
    if (first === undefined) throw new ReservationNotFoundError();
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      const u = await tx.query(
        `UPDATE scheduling.queue_entry SET triage_category = $2 WHERE id = $1::uuid RETURNING id`,
        [first.id, category],
      );
      if (u.rows.length === 0) throw new ReservationNotFoundError();
      await this.auditEntry(tx, meta, first, { triageCategory: category });
      return (await this.readEntry(tx, first.id)) as QueueEntryView;
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * Where the patient goes next: the doctor and room of the queue entry (not the booked slot, which belongs to the booking core and
   * its exclusion constraints). The room must be an active room of the entry's location; the doctor an active principal.
   */
  async assign(
    tx: Tx,
    meta: FlowMeta,
    entryId: string,
    a: { clinicianId?: string | null; roomId?: string | null },
    expectedVersion: number,
  ): Promise<QueueEntryView> {
    if (!isUuid(entryId)) throw new ReservationNotFoundError();
    const bad: string[] = [];
    for (const [k, v] of [
      ['clinicianId', a.clinicianId],
      ['roomId', a.roomId],
    ] as const)
      if (v !== undefined && v !== null && !isUuid(v)) bad.push(k);
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    const first = await this.readEntry(tx, entryId.toLowerCase());
    if (first === undefined) throw new ReservationNotFoundError();
    if (first.version !== expectedVersion) throw new PreconditionFailedError();
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      const cur = await this.readEntry(tx, first.id);
      if (cur === undefined) throw new ReservationNotFoundError();
      if (cur.version !== expectedVersion) throw new PreconditionFailedError();
      if (cur.stage === 'done') throw new InvalidTransitionError();
      const loc = (
        await tx.query(`SELECT location_id FROM scheduling.queue_entry WHERE id = $1::uuid`, [
          cur.id,
        ])
      ).rows[0] as Row;
      let clinician = cur.assignedClinicianId;
      let room = cur.roomId;
      if (a.clinicianId !== undefined) {
        if (a.clinicianId !== null) {
          const ok = await tx.query(
            `SELECT 1 FROM identity.principal WHERE id = $1::uuid AND status = 'active'`,
            [a.clinicianId],
          );
          if (ok.rows.length === 0) throw new SchedulingValidationError(['clinicianId']);
        }
        clinician = a.clinicianId === null ? null : a.clinicianId.toLowerCase();
      }
      if (a.roomId !== undefined) {
        if (a.roomId !== null) {
          const ok = await tx.query(
            `SELECT 1 FROM organisation.room WHERE id = $1::uuid AND location_id = $2::uuid AND active`,
            [a.roomId, loc['location_id']],
          );
          if (ok.rows.length === 0) throw new SchedulingValidationError(['roomId']);
        }
        room = a.roomId === null ? null : a.roomId.toLowerCase();
      }
      // 22.8 / 29.3: the new doctor's or room's time must be free for the visit's own period (409 scheduling.slot_taken otherwise).
      const slot = (
        await tx.query(
          `SELECT o.clinician_principal_id, o.room_id, o.period FROM scheduling.slot_occupancy o WHERE o.id = $1::uuid`,
          [cur.id],
        )
      ).rows[0] as Row;
      for (const [col, wanted, booked] of [
        ['clinician_principal_id', a.clinicianId, String(slot['clinician_principal_id'])],
        ['room_id', a.roomId, slot['room_id'] === null ? null : String(slot['room_id'])],
      ] as const) {
        if (wanted === undefined || wanted === null || wanted.toLowerCase() === booked) continue;
        // QA-EXEC-F05: the room's lock is the one `scheduling.occupy` takes (`rm:`), so an assignment and a booking of the same room
        // queue behind each other; the queue-entry exclusion constraint (2500) is what refuses a second holder when they race.
        if (col === 'room_id')
          await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `rm:${wanted.toLowerCase()}`,
          ]);
        const busy = await tx.query(
          `SELECT 1 FROM scheduling.slot_occupancy x
            WHERE x.id <> $1::uuid AND x.${col} = $2::uuid AND x.status = ANY($4::text[]) AND NOT x.overbook
              AND NOT (x.status = 'held' AND x.expires_at < now()) AND x.period && $3::tstzrange LIMIT 1`,
          [cur.id, wanted.toLowerCase(), slot['period'], [...ACTIVE_STATUSES]],
        );
        if (busy.rows.length > 0) throw new SlotTakenError();
        if (col === 'room_id') {
          // Another visit already sent to this room for an overlapping time (its occupancy row still says the booked room).
          const held = await tx.query(
            `SELECT 1 FROM scheduling.queue_entry q
              WHERE q.id <> $1::uuid AND q.room_id = $2::uuid AND q.stage <> 'done' AND q.room_period && $3::tstzrange LIMIT 1`,
            [cur.id, wanted.toLowerCase(), slot['period']],
          );
          if (held.rows.length > 0) throw new SlotTakenError();
        }
      }
      const u = await tx.query(
        `UPDATE scheduling.queue_entry SET assigned_clinician_principal_id = $2::uuid, room_id = $3::uuid
          WHERE id = $1::uuid AND row_version = $4 RETURNING id`,
        [cur.id, clinician, room, expectedVersion],
      );
      if (u.rows.length === 0) throw new PreconditionFailedError();
      await this.auditEntry(tx, meta, cur, { assigned: true });
      return (await this.readEntry(tx, cur.id)) as QueueEntryView;
    } catch (e) {
      translateDbError(e);
    }
  }

  private async auditEntry(
    tx: Tx,
    meta: FlowMeta,
    e: QueueEntryView,
    change: Record<string, unknown>,
  ): Promise<void> {
    await record(this.deps, tx, meta, {
      action: 'update',
      resourceType: 'scheduling.queue_entry',
      resourceId: e.id,
      patientId: e.patientId,
      change,
    });
  }

  // ===== no-show (29.3, 33.1) ==========================================================================================

  /**
   * `POST /appointments/{id}/no-show` (staff, If-Match): only for a `confirmed` visit, and only once the grace period after the start
   * has passed (`422 scheduling.grace_not_elapsed`). Writes only the occupancy status (22.8: no route updates a reservation after the
   * visit has started or ended), audited. The time of the visit is not offered again: it is in the past.
   */
  async markNoShow(
    tx: Tx,
    meta: FlowMeta,
    reservationId: string,
    expectedVersion: number,
  ): Promise<{ reservationId: string; status: 'no_show' }> {
    if (tx.scope.audience !== 'staff') throw new SchedulingScopeError();
    if (!isUuid(reservationId)) throw new ReservationNotFoundError();
    const id = reservationId.toLowerCase();
    const first = (await tx.query(APPT_SQL, [id])).rows[0] as Row | undefined;
    if (first === undefined) throw new ReservationNotFoundError();
    if (expectedVersion !== Number(first['version'])) throw new PreconditionFailedError();
    const locationId = String(first['location_id']);
    if (!this.staffLocations(tx).includes(locationId.toLowerCase()))
      throw new SchedulingScopeError();
    try {
      await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const cur = (await tx.query(APPT_SQL, [id])).rows[0] as Row | undefined;
      if (cur === undefined) throw new ReservationNotFoundError();
      if (expectedVersion !== Number(cur['version'])) throw new PreconditionFailedError();
      if (cur['status'] !== 'confirmed') throw new InvalidTransitionError();
      const policy = await this.deps.organisation.bookingPolicy(
        tx,
        String(cur['service_id']),
        locationId,
      );
      const due =
        new Date(iso(cur['starts_at'])).getTime() +
        graceMinutes(policy, String(cur['mode'])) * 60_000;
      if (this.now().getTime() < due) throw new GraceNotElapsedError();
      await tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [id]);
      await record(this.deps, tx, meta, {
        action: 'update',
        resourceType: 'scheduling.slot_reservation',
        resourceId: id,
        patientId: String(cur['patient_id']),
        locationId,
        change: { status: 'no_show' },
      });
      await this.deps.queue?.publish(tx, 'scheduling.no_show', {
        reservationId: id,
        patientId: String(cur['patient_id']),
      });
      return { reservationId: id, status: 'no_show' };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * The no-show sweep, step 1 (`scheduling.no_show_sweep`, every 5 minutes, organisation scope): confirmed visits whose start plus
   * grace has passed, in the last 48 hours, not yet flagged. The grace period is the booking policy's (video has its own).
   */
  async noShowCandidates(tx: Tx, limit = 500): Promise<NoShowCandidate[]> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    const now = this.now();
    const r = await tx.query(
      `SELECT r.id, r.patient_id, r.location_id, r.service_id, r.mode, lower(o.period) AS starts_at
         FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id = o.id
        WHERE o.status = 'confirmed' AND lower(o.period) <= $1::timestamptz
          AND lower(o.period) > $1::timestamptz - interval '48 hours'
          AND NOT EXISTS (SELECT 1 FROM scheduling.no_show_flag f WHERE f.reservation_id = r.id)
        ORDER BY lower(o.period), r.id LIMIT $2::int`,
      [now.toISOString(), limit],
    );
    const graces = new Map<string, number>();
    const out: NoShowCandidate[] = [];
    for (const x of r.rows as Row[]) {
      const key = `${String(x['service_id'])}:${String(x['location_id'])}:${String(x['mode'])}`;
      let g = graces.get(key);
      if (g === undefined) {
        g = graceMinutes(
          await this.deps.organisation.bookingPolicy(
            tx,
            String(x['service_id']),
            String(x['location_id']),
          ),
          String(x['mode']),
        );
        graces.set(key, g);
      }
      const startsAt = iso(x['starts_at']);
      if (now.getTime() < new Date(startsAt).getTime() + g * 60_000) continue;
      out.push({
        reservationId: String(x['id']),
        patientId: String(x['patient_id']),
        locationId: String(x['location_id']),
        serviceId: String(x['service_id']),
        mode: x['mode'] as 'in_person' | 'video',
        startsAt,
      });
    }
    return out;
  }

  /** Automatic no-show is allowed where the `no_show_auto` setting (G2, per location) is exactly `true`; absent or anything else means flag only. */
  async noShowAutoAllowed(tx: Tx, locationId: string): Promise<boolean> {
    return (
      (await this.deps.organisation.settingOrNull<unknown>(tx, 'no_show_auto', locationId)) === true
    );
  }

  /** The sweep, step 2 where automatic no-show is off: the flag staff see on the arrivals board. Idempotent. Organisation scope. */
  async flagNoShow(tx: Tx, meta: FlowMeta, c: NoShowCandidate): Promise<boolean> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    const r = await tx.query(
      `INSERT INTO scheduling.no_show_flag (reservation_id, organisation_id, location_id)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid) ON CONFLICT DO NOTHING`,
      [c.reservationId, c.locationId],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await record(this.deps, tx, meta, {
      action: 'update',
      resourceType: 'scheduling.no_show_flag',
      resourceId: c.reservationId,
      patientId: c.patientId,
      locationId: c.locationId,
      change: { flagged: true },
    });
    return true;
  }

  /** The sweep, step 2 where automatic no-show is on: in a patients-scope transaction of the candidate's patient. */
  async autoNoShow(tx: Tx, meta: FlowMeta, c: NoShowCandidate): Promise<'marked' | 'skipped'> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    try {
      await tx.lockPatients([c.patientId], 'key_share');
      const cur = (await tx.query(APPT_SQL, [c.reservationId])).rows[0] as Row | undefined;
      if (cur === undefined || cur['status'] !== 'confirmed') return 'skipped';
      await tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'no_show')`, [
        c.reservationId,
      ]);
      await record(this.deps, tx, meta, {
        action: 'update',
        resourceType: 'scheduling.slot_reservation',
        resourceId: c.reservationId,
        patientId: c.patientId,
        locationId: c.locationId,
        change: { status: 'no_show', automatic: true },
      });
      await this.deps.queue?.publish(tx, 'scheduling.no_show', {
        reservationId: c.reservationId,
        patientId: c.patientId,
      });
      return 'marked';
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== pre-visit read (29.2) =========================================================================================

  /** `GET /appointments/{reservationId}/previsit` for the patient: the flags and the required consents, live. Writes nothing. */
  async previsitFor(tx: Tx, reservationId: string): Promise<PrevisitView> {
    if (!isUuid(reservationId)) throw new ReservationNotFoundError();
    const r = (await tx.query(APPT_SQL, [reservationId.toLowerCase()])).rows[0] as Row | undefined;
    if (r === undefined) throw new ReservationNotFoundError();
    return this.previsit.view(tx, {
      reservationId: String(r['id']),
      patientId: String(r['patient_id']),
      serviceId: String(r['service_id']),
      occupancy: String(r['status']),
    });
  }

  /**
   * `POST /appointments/{reservationId}/previsit/consents` for the patient (HEAAA-296 D2). A proxy never reaches it (the guard answers
   * 404). A reservation that is not `confirmed` or `checked_in` answers 404 like one outside the caller's scope.
   */
  async openPrevisitConsents(
    tx: Tx,
    meta: FlowMeta,
    reservationId: string,
  ): Promise<PrevisitConsentsOpened> {
    if (!isUuid(reservationId)) throw new ReservationNotFoundError();
    const r = (await tx.query(APPT_SQL, [reservationId.toLowerCase()])).rows[0] as Row | undefined;
    if (r === undefined) throw new ReservationNotFoundError();
    if (r['status'] !== 'confirmed' && r['status'] !== 'checked_in')
      throw new ReservationNotFoundError();
    try {
      return await this.previsit.openConsents(tx, meta, {
        reservationId: String(r['id']),
        patientId: String(r['patient_id']),
        serviceId: String(r['service_id']),
      });
    } catch (e) {
      translateDbError(e);
    }
  }
}
