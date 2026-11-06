// The booking core (ARCHITECTURE 25.1, 25.2, 23.1; SHARED-BOUNDARIES 6.5): hold, confirm, cancel, reschedule, release and the
// expiry sweep. Every method runs in the caller's scoped transaction, so row-level security is the second line after the
// guard; the invariants themselves (no double booking, the overlap of one patient, the twin rows, terminal reservations) are
// the database's (migrations 0900-0903), not this code's.
//
// Lock order (25.2): the patient-root lock first (`lockPatients`, once, at the start), then the per-patient advisory lock
// `pt:`, then (inside `scheduling.occupy`) the overbook lock `ob:`, then the occupancy insert. Nothing here takes them in
// another order. A caller must pass a transaction that has not locked anything yet.
import { randomUUID } from 'node:crypto';
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import type { OrganisationService } from '../../organisation/index.js';
import {
  CutoffPassedError,
  FeeAcceptanceRequiredError,
  HoldExpiredError,
  InvalidTransitionError,
  LeadTimeError,
  LicensingRefusedError,
  MaxFutureReachedError,
  OutsideHoursError,
  OverlappingAppointmentError,
  PreconditionFailedError,
  ReservationNotFoundError,
  SchedulingScopeError,
  SchedulingValidationError,
  SlotTakenError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type {
  AppointmentView,
  AvailabilityPort,
  BookedVia,
  HeldReservation,
  HoldInput,
  OccupancyStatus,
  RequestMeta,
  SlotQuery,
  VisitMode,
} from './types.js';

type Row = Record<string, unknown>;

export interface SchedulingCoreDeps {
  audit: AuditService;
  organisation: Pick<OrganisationService, 'bookingPolicy' | 'settingOrNull'>;
  availability: AvailabilityPort;
  queue?: Queue;
  now?: () => Date;
}

/** The statuses that occupy the doctor's and the room's time (the exclusion constraints' predicate, 0900). */
export const ACTIVE_STATUSES = ['held', 'confirmed', 'checked_in', 'in_consultation', 'completed'] as const;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toView = (r: Row): AppointmentView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  serviceId: String(r['service_id']),
  locationId: String(r['location_id']),
  locationTimeZone: r['time_zone'] === null || r['time_zone'] === undefined ? '' : String(r['time_zone']),
  clinicianId: String(r['clinician_principal_id']),
  roomId: r['room_id'] === null ? null : String(r['room_id']),
  mode: r['mode'] as VisitMode,
  status: r['status'] as OccupancyStatus,
  startsAt: iso(r['starts_at']),
  endsAt: iso(r['ends_at']),
  expiresAt: isoOrNull(r['expires_at']),
  reason: r['reason'] === null ? null : String(r['reason']),
  bookedVia: r['booked_via'] as BookedVia,
  rescheduledFromId: r['rescheduled_from_id'] === null ? null : String(r['rescheduled_from_id']),
  cancelReason: r['cancel_reason'] === null ? null : String(r['cancel_reason']),
  lateChange: r['late_change'] === null ? null : r['late_change'] === true,
  version: Number(r['row_version']),
});

const READ_SQL = `
  SELECT r.id, r.patient_id, r.service_id, r.location_id, l.time_zone, r.clinician_principal_id, o.room_id, r.mode, o.status,
         lower(o.period) AS starts_at, upper(o.period) AS ends_at, o.expires_at, r.reason, r.booked_via, r.rescheduled_from_id,
         r.cancel_reason, r.late_change, (r.row_version + o.row_version) AS row_version, r.booked_by_principal_id
    FROM scheduling.slot_reservation r
    JOIN scheduling.slot_occupancy o ON o.id = r.id
    LEFT JOIN organisation.location l ON l.id = r.location_id
   WHERE r.id = $1::uuid`;

/** Start times after `q.startsAt` at the same clock grid that no active occupancy of the doctor or room covers (helper for availability ports). */
export async function nearbyFreeStarts(
  tx: Tx,
  q: SlotQuery,
  opts: { limit?: number; steps?: number } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 5;
  const step = q.endsAt.getTime() - q.startsAt.getTime();
  const out: string[] = [];
  for (let k = 1; k <= (opts.steps ?? 48) && out.length < limit; k++) {
    const s = new Date(q.startsAt.getTime() + k * step);
    const e = new Date(s.getTime() + step);
    const busy = await tx.query(
      `SELECT 1 FROM scheduling.slot_occupancy o
        WHERE o.status = ANY($4::text[]) AND NOT o.overbook AND o.period && tstzrange($1::timestamptz, $2::timestamptz, '[)')
          AND (o.clinician_principal_id = $3::uuid OR ($5::uuid IS NOT NULL AND o.room_id = $5::uuid)) LIMIT 1`,
      [s.toISOString(), e.toISOString(), q.clinicianId, [...ACTIVE_STATUSES], q.roomId],
    );
    if (busy.rows.length === 0) out.push(s.toISOString());
  }
  return out;
}

export class SchedulingCoreService {
  constructor(private readonly deps: SchedulingCoreDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (p === undefined) throw new SchedulingScopeError();
    return p;
  }

  private onBehalf(input: HoldInput): string {
    if (!isUuid(input.onBehalfOfPrincipalId)) throw new SchedulingValidationError(['onBehalfOfPrincipalId']);
    return input.onBehalfOfPrincipalId.toLowerCase();
  }

  /** The appointment as the caller's RLS shows it, or undefined. */
  async get(tx: Tx, reservationId: string): Promise<AppointmentView | undefined> {
    if (!isUuid(reservationId)) return undefined;
    const r = await tx.query(READ_SQL, [reservationId]);
    return r.rows[0] === undefined ? undefined : toView(r.rows[0] as Row);
  }

  /** Appointments of one patient, newest start first, optionally by status and period (29.2). */
  async list(
    tx: Tx,
    patientId: string,
    f: { status?: OccupancyStatus; from?: string; to?: string } = {},
  ): Promise<AppointmentView[]> {
    if (!isUuid(patientId)) throw new SchedulingValidationError(['patientId']);
    const r = await tx.query(
      `${READ_SQL.replace('WHERE r.id = $1::uuid', 'WHERE r.patient_id = $1::uuid')}
          AND ($2::text IS NULL OR o.status = $2::text) AND ($3::timestamptz IS NULL OR upper(o.period) > $3::timestamptz)
          AND ($4::timestamptz IS NULL OR lower(o.period) < $4::timestamptz)
        ORDER BY lower(o.period) DESC, r.id LIMIT 200`,
      [patientId, f.status ?? null, f.from ?? null, f.to ?? null],
    );
    return r.rows.map((x) => toView(x as Row));
  }

  // ===== hold (25.1) ===================================================================================================

  /**
   * `POST /holds`. The caller opens the transaction (and the idempotency row) and passes it here untouched. Who booked is decided here
   * from the transaction's scope, never from the request: staff -> `staff`; a patient session -> `proxy` for a patient it reaches as a
   * proxy, else `patient`; only a system job (the waitlist offer, 25.6) names `waitlist`.
   */
  async hold(
    tx: Tx,
    meta: RequestMeta,
    input: HoldInput,
    systemBookedVia?: 'waitlist',
  ): Promise<HeldReservation> {
    const aud = tx.scope.audience;
    const principal = aud === 'system' ? this.onBehalf(input) : this.principal(tx);
    let bookedVia: BookedVia;
    if (aud === 'staff') bookedVia = 'staff';
    else if (aud === 'patient')
      bookedVia = (tx.scope.proxyPatientIds ?? []).some(
        (p) => typeof input.patientId === 'string' && p.toLowerCase() === input.patientId.toLowerCase(),
      )
        ? 'proxy'
        : 'patient';
    else if (aud === 'system' && systemBookedVia === 'waitlist') bookedVia = 'waitlist';
    else throw new SchedulingScopeError();
    const v = this.validateHold(input, bookedVia);

    try {
      // (2) The patient root, first (25.2 rule 1). Also checks visibility (PM008 -> 404) and that the patient is not merged on write (PM001).
      await tx.lockPatients([v.patientId], 'key_share');
      // (3) One lock per patient, whatever the service (TDR-07): BR-04 and the overlap of the same patient's own reservations.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('pt:' || $1::text))`, [v.patientId]);

      // A patient cannot read the base table (22.5.1): the active services come through the directory view. Staff and system read the table.
      const svc = (
        await tx.query(
          aud === 'patient'
            ? `SELECT duration_min, mode FROM organisation.public_service WHERE id = $1::uuid`
            : `SELECT duration_min, mode FROM organisation.service WHERE id = $1::uuid AND active`,
          [v.serviceId],
        )
      ).rows[0] as Row | undefined;
      if (svc === undefined) throw new SchedulingValidationError(['serviceId']);
      if (svc['mode'] !== 'either' && svc['mode'] !== v.mode) throw new SchedulingValidationError(['mode']);
      const loc = (
        await tx.query(`SELECT active FROM organisation.location WHERE id = $1::uuid`, [v.locationId])
      ).rows[0] as Row | undefined;
      if (loc === undefined || loc['active'] !== true) throw new SchedulingValidationError(['locationId']);
      // A room is assigned by the clinic: the booker of a patient session never chooses one.
      if (v.roomId !== null) {
        if (aud === 'patient') throw new SchedulingValidationError(['roomId']);
        const room = await tx.query(
          `SELECT 1 FROM organisation.room WHERE id = $1::uuid AND location_id = $2::uuid AND active`,
          [v.roomId, v.locationId],
        );
        if (room.rows.length === 0) throw new SchedulingValidationError(['roomId']);
      }

      const starts = new Date(v.startsAt);
      // The occupied period is the service's duration; the buffer between visits is part of the slot grid the availability module offers.
      const ends = new Date(starts.getTime() + Number(svc['duration_min']) * 60_000);
      const period = `[${starts.toISOString()},${ends.toISOString()})`;
      const q: SlotQuery = {
        clinicianId: v.clinicianId,
        locationId: v.locationId,
        serviceId: v.serviceId,
        roomId: v.roomId,
        startsAt: starts,
        endsAt: ends,
        mode: v.mode,
      };

      const policy = await this.deps.organisation.bookingPolicy(tx, v.serviceId, v.locationId);
      if (
        bookedVia !== 'staff' &&
        starts.getTime() < this.now().getTime() + policy.leadTimeMin * 60_000
      )
        throw new LeadTimeError();
      if (starts.getTime() <= this.now().getTime()) throw new LeadTimeError();

      // (3) BR-04 and the overlap rule, both under the per-patient lock. A replaced appointment (reschedule) is left out of both.
      const replaced = v.rescheduleOf;
      if (replaced !== null) {
        const own = await tx.query(
          `SELECT 1 FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
            WHERE r.id = $1::uuid AND r.patient_id = $2::uuid AND o.status = 'confirmed'`,
          [replaced, v.patientId],
        );
        if (own.rows.length === 0) throw new SchedulingValidationError(['rescheduleOf']);
      }
      const future = Number(
        (
          await tx.query(
            `SELECT count(*)::int AS n FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
              WHERE r.patient_id = $1::uuid AND r.service_id = $2::uuid AND r.id IS DISTINCT FROM $3::uuid AND lower(o.period) > now()
                AND (o.status = 'confirmed' OR (o.status = 'held' AND o.expires_at > now()))`,
            [v.patientId, v.serviceId, replaced],
          )
        ).rows[0]?.['n'] ?? 0,
      );
      if (future >= policy.maxFuturePerPatient) throw new MaxFutureReachedError();

      const overlap = await tx.query(
        `SELECT 1 FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id
          WHERE r.patient_id = $1::uuid AND r.id IS DISTINCT FROM $3::uuid AND o.period && $2::tstzrange
            AND (o.status IN ('confirmed', 'checked_in', 'in_consultation', 'completed') OR (o.status = 'held' AND o.expires_at > now()))
          LIMIT 1`,
        [v.patientId, period, replaced],
      );
      if (overlap.rows.length > 0) {
        // When the very slot asked for is already someone's (the same patient racing themselves for one slot, TC-BK-13), the honest
        // answer is "taken, here are others"; the overlap answer is for different slots that collide in the patient's own diary.
        if (await this.slotBusy(tx, q)) throw new SlotTakenError(await this.safeAlternatives(tx, q));
        throw new OverlappingAppointmentError();
      }

      // (4) Licensing (TL-1) for video; an in-person visit needs none.
      let licensing: 'not_required' | 'allowed' | 'flagged' = 'not_required';
      let stated: string | null = null;
      if (v.mode === 'video') {
        stated = v.patientState;
        const licensed = (
          await tx.query(
            `SELECT jurisdiction_code FROM identity.licensed_state
              WHERE principal_id = $1::uuid AND (expires_on IS NULL OR expires_on >= current_date)`,
            [v.clinicianId],
          )
        ).rows.map((x) => String((x as Row)['jurisdiction_code']));
        const verdict = await this.licensing(tx, licensed, stated as string);
        if (verdict === 'allowed') licensing = 'allowed';
        else {
          const mode = await this.deps.organisation.settingOrNull<string>(
            tx,
            'telehealth_licensing_mode',
            v.locationId,
          );
          if (mode === 'flag') licensing = 'flagged';
          else throw new LicensingRefusedError();
        }
      }

      // Availability (BE-12): on the template, not on leave. Also tells whether the session is overbookable.
      const avail = await this.deps.availability.resolve(tx, q);
      if (!avail.ok) throw new OutsideHoursError();
      const overbook = avail.overbook?.sessionKey;

      // (5) Occupancy: expires stale holds (doctor and room), checks the overbook cap, inserts; the constraint decides. A savepoint keeps the
      // transaction usable after the refusal, so the fresh search for alternatives runs inside it.
      const id = uuidv7();
      await tx.query('SAVEPOINT booking_occupy');
      let expiresAt: Date;
      try {
        const r = await tx.query(
          `SELECT scheduling.occupy($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::tstzrange, $6::int, $7::boolean, $8::text, $9::int) AS expires_at`,
          [
            id,
            v.locationId,
            v.clinicianId,
            v.roomId,
            period,
            policy.holdMinutes * 60,
            overbook !== undefined,
            overbook ?? null,
            policy.overbookCapPerSession,
          ],
        );
        expiresAt = (r.rows[0] as Row)['expires_at'] as Date;
        await tx.query('RELEASE SAVEPOINT booking_occupy');
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === '23P01') {
          await tx.query('ROLLBACK TO SAVEPOINT booking_occupy');
          throw new SlotTakenError(await this.safeAlternatives(tx, q));
        }
        throw e;
      }

      // (6) The reservation, under the caller's own RLS: WITH CHECK refuses a patient the caller may not book for.
      await tx.query(
        `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode,
                                                  reason, patient_stated_state, licensing_result, booked_by_principal_id, booked_via,
                                                  follow_up_of_encounter_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::uuid, $11, $12::uuid, $10::uuid)`,
        [
          id,
          v.patientId,
          v.serviceId,
          v.locationId,
          v.clinicianId,
          v.mode,
          v.reason,
          stated,
          licensing,
          principal,
          bookedVia,
          v.followUpOfEncounterId,
        ],
      );

      // (7) Audit and outbox.
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'scheduling.slot_reservation',
        resourceId: id,
        patientId: v.patientId,
        locationId: v.locationId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.deps.queue?.publish(tx, 'scheduling.reservation_held', {
        reservationId: id,
        patientId: v.patientId,
      });
      return { reservationId: id, expiresAt: expiresAt.toISOString() };
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== confirm (25.1) ================================================================================================

  /** `POST /appointments/{id}/confirm`. Idempotent by state for the principal who booked. */
  async confirm(tx: Tx, meta: RequestMeta, reservationId: string): Promise<AppointmentView> {
    const principal = this.principal(tx);
    const first = await this.get(tx, reservationId);
    if (first === undefined) throw new ReservationNotFoundError();
    try {
      // O-6: the strongest root lock this transaction will need (ensure_care_relationship writes), before any child-row write.
      await tx.lockPatients([first.patientId], 'no_key_update');
      const cur = await this.reread(tx, reservationId);
      if (cur.status === 'confirmed') {
        const booker = (
          await tx.query(`SELECT booked_by_principal_id FROM scheduling.slot_reservation WHERE id = $1::uuid`, [reservationId])
        ).rows[0] as Row | undefined;
        if (booker !== undefined && String(booker['booked_by_principal_id']) === principal) return cur;
        throw new InvalidTransitionError();
      }
      if (cur.status !== 'held') throw new InvalidTransitionError();

      const res = (
        await tx.query(`SELECT scheduling.set_status($1::uuid, 'held', 'confirmed') AS result`, [reservationId])
      ).rows[0] as Row;
      if (res['result'] === 'hold_expired') {
        throw new HoldExpiredError(await this.safeAlternativesFor(tx, cur));
      }
      await tx.callScopeOwner(
        'patient.ensure_care_relationship',
        [meta.requestId ?? randomUUID(), cur.patientId, cur.locationId, 'booking'],
        [cur.patientId],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'scheduling.slot_reservation',
        resourceId: reservationId,
        patientId: cur.patientId,
        locationId: cur.locationId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.deps.queue?.publish(tx, 'scheduling.reservation_confirmed', {
        reservationId,
        patientId: cur.patientId,
      });
      return await this.reread(tx, reservationId);
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== cancel (25.1) =================================================================================================

  /**
   * Cancel or release. A patient or proxy cancel is `cancelled_patient` and follows the cut-off; a staff cancel is
   * `cancelled_clinic`, needs a reason and is never blocked. `expectedVersion` is the If-Match value.
   */
  async cancel(
    tx: Tx,
    meta: RequestMeta,
    reservationId: string,
    o: { reason?: string | null; acceptFee?: boolean; expectedVersion?: number } = {},
  ): Promise<AppointmentView> {
    const staff = tx.scope.audience === 'staff';
    const reason = o.reason === undefined || o.reason === null ? null : String(o.reason).trim();
    if (reason !== null && reason.length > 500) throw new SchedulingValidationError(['reason']);
    if (staff && (reason === null || reason.length === 0)) throw new SchedulingValidationError(['reason']);
    const first = await this.get(tx, reservationId);
    if (first === undefined) throw new ReservationNotFoundError();
    if (o.expectedVersion !== undefined && o.expectedVersion !== first.version) throw new PreconditionFailedError();
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      const cur = await this.reread(tx, reservationId);
      if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw new PreconditionFailedError();
      if (cur.status !== 'held' && cur.status !== 'confirmed') throw new InvalidTransitionError();

      const policy = await this.deps.organisation.bookingPolicy(tx, cur.serviceId, cur.locationId);
      // Only a confirmed appointment has a cut-off; releasing a hold is free (23.1: held -> cancelled_patient).
      const late =
        cur.status === 'confirmed' &&
        new Date(cur.startsAt).getTime() - this.now().getTime() < policy.cutoffHours * 3_600_000;
      if (late && !staff) {
        if (policy.lateChange === 'block') throw new CutoffPassedError();
        if (o.acceptFee !== true) throw new FeeAcceptanceRequiredError();
      }
      // N-2: the reservation's own fields first; once the occupancy is in a K state the reservation accepts no update.
      await tx.query(
        `UPDATE scheduling.slot_reservation SET cancel_reason = $2, late_change = $3 WHERE id = $1::uuid`,
        [reservationId, reason, late],
      );
      const to = staff ? 'cancelled_clinic' : 'cancelled_patient';
      await tx.query(`SELECT scheduling.set_status($1::uuid, $2, $3)`, [reservationId, cur.status, to]);
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'scheduling.slot_reservation',
        resourceId: reservationId,
        patientId: cur.patientId,
        locationId: cur.locationId,
        change: { status: to, lateChange: late, feeAccepted: late && !staff && o.acceptFee === true },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.deps.queue?.publish(tx, 'scheduling.reservation_cancelled', {
        reservationId,
        patientId: cur.patientId,
      });
      await this.deps.queue?.publish(tx, 'scheduling.slot_freed', { occupancyId: reservationId });
      return await this.reread(tx, reservationId);
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== reschedule (25.1) =============================================================================================

  /** `POST /appointments/{id}/reschedule`: `newHoldId` is a hold of the same patient made with `rescheduleOf` = this appointment. */
  async reschedule(
    tx: Tx,
    meta: RequestMeta,
    reservationId: string,
    newHoldId: string,
    o: { expectedVersion?: number } = {},
  ): Promise<AppointmentView> {
    if (!isUuid(newHoldId) || newHoldId.toLowerCase() === reservationId.toLowerCase())
      throw new SchedulingValidationError(['newHoldId']);
    const old0 = await this.get(tx, reservationId);
    const new0 = await this.get(tx, newHoldId);
    if (old0 === undefined || new0 === undefined) throw new ReservationNotFoundError();
    if (old0.patientId !== new0.patientId) throw new SchedulingValidationError(['newHoldId']);
    if (o.expectedVersion !== undefined && o.expectedVersion !== old0.version) throw new PreconditionFailedError();
    const staff = tx.scope.audience === 'staff';
    try {
      await tx.lockPatients([old0.patientId], 'no_key_update');
      const old = await this.reread(tx, reservationId);
      const hold = await this.reread(tx, newHoldId);
      if (o.expectedVersion !== undefined && o.expectedVersion !== old.version) throw new PreconditionFailedError();
      if (old.status !== 'confirmed' || hold.status !== 'held') throw new InvalidTransitionError();
      if (old.serviceId !== hold.serviceId) throw new SchedulingValidationError(['newHoldId']);
      const linked = await tx.query(
        `SELECT 1 FROM scheduling.slot_reservation WHERE rescheduled_from_id = $1::uuid`,
        [reservationId],
      );
      if (linked.rows.length > 0) throw new InvalidTransitionError();

      // The cut-off applies to the old appointment (25.1).
      const policy = await this.deps.organisation.bookingPolicy(tx, old.serviceId, old.locationId);
      const late = new Date(old.startsAt).getTime() - this.now().getTime() < policy.cutoffHours * 3_600_000;
      if (late && !staff) {
        if (policy.lateChange === 'block') throw new CutoffPassedError();
        // `fee` is stored only (D-3); a reschedule carries no acceptFee in the catalogue, so a fee policy refuses until it does.
        throw new FeeAcceptanceRequiredError();
      }

      const confirmed = (
        await tx.query(`SELECT scheduling.set_status($1::uuid, 'held', 'confirmed') AS result`, [newHoldId])
      ).rows[0] as Row;
      if (confirmed['result'] === 'hold_expired') throw new HoldExpiredError(await this.safeAlternativesFor(tx, hold));
      // Reschedule writes no field of the old reservation, only its occupancy status (N-2).
      await tx.query(`SELECT scheduling.set_status($1::uuid, 'confirmed', 'rescheduled')`, [reservationId]);
      await tx.query(`UPDATE scheduling.slot_reservation SET rescheduled_from_id = $2::uuid WHERE id = $1::uuid`, [
        newHoldId,
        reservationId,
      ]);
      await tx.callScopeOwner(
        'patient.ensure_care_relationship',
        [meta.requestId ?? randomUUID(), hold.patientId, hold.locationId, 'booking'],
        [hold.patientId],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'scheduling.slot_reservation',
        resourceId: reservationId,
        patientId: old.patientId,
        locationId: old.locationId,
        change: { status: 'rescheduled', replacedBy: newHoldId },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await this.deps.queue?.publish(tx, 'scheduling.reservation_rescheduled', {
        reservationId,
        newReservationId: newHoldId,
        patientId: old.patientId,
      });
      await this.deps.queue?.publish(tx, 'scheduling.slot_freed', { occupancyId: reservationId });
      return await this.reread(tx, newHoldId);
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== expiry sweep (25.1) ===========================================================================================

  /** The cleanup job (`org` scope, system): frees lapsed holds and publishes `slot_freed` for each. Not needed for correctness. */
  async sweepExpired(tx: Tx, limit = 500): Promise<string[]> {
    const r = await tx.query(`SELECT scheduling.expire_holds($1::int) AS id`, [limit]);
    const ids = r.rows.map((x) => String((x as Row)['id']));
    for (const id of ids) await this.deps.queue?.publish(tx, 'scheduling.slot_freed', { occupancyId: id });
    return ids;
  }

  // ===== helpers =======================================================================================================

  private async reread(tx: Tx, id: string): Promise<AppointmentView> {
    const v = await this.get(tx, id);
    if (v === undefined) throw new ReservationNotFoundError();
    return v;
  }

  private async slotBusy(tx: Tx, q: SlotQuery): Promise<boolean> {
    const r = await tx.query(
      `SELECT 1 FROM scheduling.slot_occupancy o
        WHERE o.status = ANY($4::text[]) AND NOT o.overbook AND o.period && tstzrange($1::timestamptz, $2::timestamptz, '[)')
          AND (o.clinician_principal_id = $3::uuid OR ($5::uuid IS NOT NULL AND o.room_id = $5::uuid))
          AND NOT (o.status = 'held' AND o.expires_at < now()) LIMIT 1`,
      [q.startsAt.toISOString(), q.endsAt.toISOString(), q.clinicianId, [...ACTIVE_STATUSES], q.roomId],
    );
    return r.rows.length > 0;
  }

  private async safeAlternatives(tx: Tx, q: SlotQuery): Promise<string[]> {
    try {
      return (await this.deps.availability.alternatives(tx, q)).slice(0, 5);
    } catch {
      // Alternatives are a courtesy: a failing search must not turn "taken" into a server error.
      return [];
    }
  }

  private async safeAlternativesFor(tx: Tx, a: AppointmentView): Promise<string[]> {
    return this.safeAlternatives(tx, {
      clinicianId: a.clinicianId,
      locationId: a.locationId,
      serviceId: a.serviceId,
      roomId: a.roomId,
      startsAt: new Date(a.startsAt),
      endsAt: new Date(a.endsAt),
      mode: a.mode,
    });
  }

  private async licensing(
    tx: Tx,
    clinicianStates: readonly string[],
    patientState: string,
  ): Promise<'allowed' | 'refused'> {
    const state = patientState.trim().toUpperCase();
    const r = await tx.query(
      `SELECT telehealth_allowed FROM organisation.operating_state
        WHERE jurisdiction_code = $1 AND effective_from <= current_date ORDER BY effective_from DESC LIMIT 1`,
      [state],
    );
    if ((r.rows[0] as Row | undefined)?.['telehealth_allowed'] !== true) return 'refused';
    return clinicianStates.some((c) => c.trim().toUpperCase() === state) ? 'allowed' : 'refused';
  }

  private validateHold(
    i: HoldInput,
    bookedVia: BookedVia,
  ): {
    patientId: string;
    serviceId: string;
    locationId: string;
    clinicianId: string;
    roomId: string | null;
    startsAt: string;
    mode: VisitMode;
    reason: string | null;
    patientState: string | null;
    rescheduleOf: string | null;
    followUpOfEncounterId: string | null;
  } {
    const bad: string[] = [];
    const uuid = (name: string, v: unknown, optional = false): string | null => {
      if ((v === undefined || v === null) && optional) return null;
      if (!isUuid(v)) {
        bad.push(name);
        return null;
      }
      return v.toLowerCase();
    };
    const patientId = uuid('patientId', i.patientId);
    const serviceId = uuid('serviceId', i.serviceId);
    const locationId = uuid('locationId', i.locationId);
    const clinicianId = uuid('clinicianId', i.clinicianId);
    const roomId = uuid('roomId', i.roomId, true);
    const rescheduleOf = uuid('rescheduleOf', i.rescheduleOf, true);
    const followUp = uuid('followUpOfEncounterId', i.followUpOfEncounterId, true);
    const t = typeof i.startsAt === 'string' ? Date.parse(i.startsAt) : Number.NaN;
    if (!Number.isFinite(t) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(i.startsAt)) bad.push('startsAt');
    if (i.mode !== 'in_person' && i.mode !== 'video') bad.push('mode');
    const reason = i.reason === undefined || i.reason === null ? null : String(i.reason);
    if (reason !== null && reason.length > 500) bad.push('reason');
    const state =
      i.patientState === undefined || i.patientState === null
        ? null
        : String(i.patientState).trim().toUpperCase();
    if (state !== null && !/^[A-Z]{2}$/.test(state)) bad.push('patientState');
    if (i.mode === 'video' && state === null) bad.push('patientState');
    if (!['patient', 'proxy', 'staff', 'waitlist'].includes(bookedVia)) bad.push('bookedVia');
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    return {
      patientId: patientId as string,
      serviceId: serviceId as string,
      locationId: locationId as string,
      clinicianId: clinicianId as string,
      roomId,
      startsAt: new Date(t).toISOString(),
      mode: i.mode,
      reason: reason === null || reason.trim() === '' ? null : reason,
      patientState: state,
      rescheduleOf,
      followUpOfEncounterId: followUp,
    };
  }
}
