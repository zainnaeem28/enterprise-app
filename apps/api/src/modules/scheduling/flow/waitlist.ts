// The waitlist (ARCHITECTURE 25.6, 22.8, 22.16; PRD BR-03, RA-R1-22, TC-BK-19..22): entries, offers for a freed slot, accept, decline and
// the clean lapse of an offer.
//
// A freed slot (`scheduling.slot_freed`) becomes at most one offer at a time:
//   1. the first `active` entry in `position_at` order whose service, place, doctor and window fit (and that has not already been
//      offered this very slot) gets a HOLD through the booking core's `scheduling.hold` (25.1 steps 2-6: the per-patient lock, BR-04, the
//      overlap rule, licensing, availability, `scheduling.occupy`). If the hold is refused for that patient the next entry is tried; if the
//      slot is gone the job ends. The hold's life is the offer time (Setting `waitlist_offer_minutes`: 30 min, 15 within 24 h);
//   2. a `waitlist_offer` row, the entry moves `active -> offered`, a PHI-free message is queued and `scheduling.expire_offer` is
//      scheduled for the expiry, all in the same transaction as the hold;
//   3. accept confirms the hold (`held -> confirmed`, the same function as a normal confirm); decline or expiry releases it, the entry
//      returns to `active` (it keeps its place and is not offered this slot again) and `slot_freed` offers it to the next entry.
// The first acceptance inside the window wins because only one hold can exist for a slot: the exclusion constraints say so, and
// `scheduling.set_status` serialises accept against lapse on the occupancy row.
import { randomUUID } from 'node:crypto';
import type { Tx } from '@ehr/kernel';
import {
  LeadTimeError,
  MaxFutureReachedError,
  OutsideHoursError,
  OverlappingAppointmentError,
  PatientMergedError,
  LicensingRefusedError,
  ReservationNotFoundError,
  SchedulingScopeError,
  SchedulingValidationError,
  SlotTakenError,
  translateDbError,
} from '../core/errors.js';
import { isUuid, uuidv7 } from '../core/ids.js';
import { SchedulingCoreService } from '../core/service.js';
import { InvalidTransitionError, OfferExpiredError, WaitlistDisabledError } from './errors.js';
import { clock, iso, isoOrNull, record } from './common.js';
import type { FlowDeps, Row } from './common.js';
import type {
  FlowMeta,
  FreedSlot,
  OfferCandidate,
  OfferView,
  WaitlistEntryInput,
  WaitlistEntryView,
  WaitlistStatus,
} from './types.js';

const FREED = ['cancelled_patient', 'cancelled_clinic', 'expired', 'rescheduled'];
const ACTIVE = ['held', 'confirmed', 'checked_in', 'in_consultation', 'completed'];
const MAX_WINDOW_DAYS = 366;
const CANDIDATES = 50;

/** `patient.<name>` for a patient_scope_owner function; always after `lockPatients(..., 'no_key_update')` (25.2), as in the booking core. */
const scopeOwnerFn = (n: string): string => `patient.${n}`;

const range = (from: string, to: string): string => `[${from},${to})`;

const entryView = (r: Row): WaitlistEntryView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  ...(r['given_name'] === undefined
    ? {}
    : {
        patientName:
          r['given_name'] === null
            ? null
            : `${String(r['given_name'])} ${String(r['family_name'] ?? '')}`.trim(),
      }),
  serviceId: String(r['service_id']),
  locationId: r['location_id'] === null ? null : String(r['location_id']),
  clinicianId: r['clinician_principal_id'] === null ? null : String(r['clinician_principal_id']),
  from: iso(r['w_from']),
  to: iso(r['w_to']),
  status: r['status'] as WaitlistStatus,
  cancelReason: (r['cancel_reason'] as WaitlistEntryView['cancelReason']) ?? null,
  positionAt: iso(r['position_at']),
  openOffer:
    r['offer_id'] === null || r['offer_id'] === undefined
      ? null
      : { id: String(r['offer_id']), expiresAt: iso(r['offer_expires_at']) },
  version: Number(r['row_version']),
});

const ENTRY_SQL = `
  SELECT e.id, e.patient_id, e.service_id, e.location_id, e.clinician_principal_id, lower(e."window") AS w_from, upper(e."window") AS w_to,
         e.status, e.cancel_reason, e.position_at, e.row_version, o.id AS offer_id, o.expires_at AS offer_expires_at
    FROM scheduling.waitlist_entry e
    LEFT JOIN scheduling.waitlist_offer o ON o.waitlist_entry_id = e.id AND o.status = 'offered'`;

const OFFER_SQL = `
  SELECT w.id, w.waitlist_entry_id, w.patient_id, w.occupancy_id, w.status, w.expires_at, w.decided_at, o.location_id,
         lower(o.period) AS starts_at, upper(o.period) AS ends_at, r.service_id, (w.expires_at <= now()) AS lapsed
    FROM scheduling.waitlist_offer w
    JOIN scheduling.slot_occupancy o ON o.id = w.occupancy_id
    JOIN scheduling.slot_reservation r ON r.id = w.occupancy_id`;

const offerView = (r: Row): OfferView => ({
  id: String(r['id']),
  waitlistEntryId: String(r['waitlist_entry_id']),
  patientId: String(r['patient_id']),
  reservationId: String(r['occupancy_id']),
  locationId: String(r['location_id']),
  serviceId: String(r['service_id']),
  startsAt: iso(r['starts_at']),
  endsAt: iso(r['ends_at']),
  status: r['status'] as OfferView['status'],
  expiresAt: iso(r['expires_at']),
  decidedAt: isoOrNull(r['decided_at']),
});

export type OfferOutcome =
  | { outcome: 'offered'; offerId: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'slot_gone' };

export type LapseOutcome = 'expired' | 'not_due' | 'already_decided' | 'gone';

export class WaitlistService {
  constructor(private readonly deps: FlowDeps) {}

  private now(): Date {
    return clock(this.deps);
  }

  // ===== entries (29.2, 29.3) ==========================================================================================

  /** `POST /waitlist-entries` (patient, proxy) or the desk on a patient's behalf. `422 scheduling.waitlist_disabled` when the policy has it off. */
  async createEntry(tx: Tx, meta: FlowMeta, input: WaitlistEntryInput): Promise<WaitlistEntryView> {
    const aud = tx.scope.audience;
    if (aud !== 'patient' && aud !== 'staff') throw new SchedulingScopeError();
    const principal = tx.scope.principalId;
    if (principal === undefined) throw new SchedulingScopeError();
    const bad: string[] = [];
    const uuid = (n: string, v: unknown, optional: boolean): string | null => {
      if ((v === undefined || v === null) && optional) return null;
      if (!isUuid(v)) {
        bad.push(n);
        return null;
      }
      return v.toLowerCase();
    };
    const patientId = uuid('patientId', input.patientId, false);
    const serviceId = uuid('serviceId', input.serviceId, false);
    const locationId = uuid('locationId', input.locationId, true);
    const clinicianId = uuid('clinicianId', input.clinicianId, true);
    const t0 = typeof input.from === 'string' ? Date.parse(input.from) : Number.NaN;
    const t1 = typeof input.to === 'string' ? Date.parse(input.to) : Number.NaN;
    const zoned = (v: unknown): boolean =>
      typeof v === 'string' && /[zZ]|[+-]\d{2}:?\d{2}$/.test(v);
    if (!Number.isFinite(t0) || !zoned(input.from)) bad.push('from');
    if (!Number.isFinite(t1) || !zoned(input.to)) bad.push('to');
    if (
      Number.isFinite(t0) &&
      Number.isFinite(t1) &&
      (t1 <= t0 || t1 - t0 > MAX_WINDOW_DAYS * 86_400_000)
    )
      bad.push('to');
    if (bad.length > 0 || patientId === null || serviceId === null)
      throw new SchedulingValidationError(bad);
    const from = new Date(t0).toISOString();
    const to = new Date(t1).toISOString();
    if (new Date(t1).getTime() <= this.now().getTime()) throw new SchedulingValidationError(['to']);

    try {
      await tx.lockPatients([patientId], 'key_share');
      const svc = await tx.query(
        aud === 'patient'
          ? `SELECT 1 FROM organisation.public_service WHERE id = $1::uuid`
          : `SELECT 1 FROM organisation.service WHERE id = $1::uuid AND active`,
        [serviceId],
      );
      if (svc.rows.length === 0) throw new SchedulingValidationError(['serviceId']);
      if (locationId !== null) {
        const loc = await tx.query(
          `SELECT 1 FROM organisation.location WHERE id = $1::uuid AND active`,
          [locationId],
        );
        if (loc.rows.length === 0) throw new SchedulingValidationError(['locationId']);
      }
      const policy = await this.deps.organisation.bookingPolicy(tx, serviceId, locationId);
      if (!policy.waitlistEnabled) throw new WaitlistDisabledError();
      const id = uuidv7();
      await tx.query('SAVEPOINT waitlist_insert');
      try {
        await tx.query(
          `INSERT INTO scheduling.waitlist_entry (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, "window", created_by)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::tstzrange, $7::uuid)`,
          [id, patientId, serviceId, locationId, clinicianId, range(from, to), principal],
        );
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === '23503') {
          await tx.query('ROLLBACK TO SAVEPOINT waitlist_insert');
          throw new SchedulingValidationError(['clinicianId']);
        }
        throw e;
      }
      await tx.query('RELEASE SAVEPOINT waitlist_insert');
      await record(this.deps, tx, meta, {
        action: 'create',
        resourceType: 'scheduling.waitlist_entry',
        resourceId: id,
        patientId,
        ...(locationId === null ? {} : { locationId }),
      });
      return await this.readEntry(tx, id);
    } catch (e) {
      translateDbError(e);
    }
  }

  async readEntry(tx: Tx, id: string): Promise<WaitlistEntryView> {
    if (!isUuid(id)) throw new ReservationNotFoundError();
    const r = await tx.query(`${ENTRY_SQL} WHERE e.id = $1::uuid`, [id.toLowerCase()]);
    if (r.rows[0] === undefined) throw new ReservationNotFoundError();
    return entryView(r.rows[0] as Row);
  }

  /**
   * `DELETE /waitlist-entries/{id}`: the patient (or proxy) takes themselves off the list, or staff do. An entry with an open offer is
   * declined first (the held slot goes to the next entry), and only the patient can do that. Cancelling twice is the same answer.
   */
  async cancelEntry(tx: Tx, meta: FlowMeta, entryId: string): Promise<WaitlistEntryView> {
    const aud = tx.scope.audience;
    if (aud !== 'patient' && aud !== 'staff') throw new SchedulingScopeError();
    const first = await this.readEntry(tx, entryId);
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      const cur = await this.readEntry(tx, first.id);
      if (cur.status === 'cancelled') return cur;
      if (cur.status === 'fulfilled' || cur.status === 'expired')
        throw new InvalidTransitionError();
      if (cur.status === 'offered') {
        if (aud !== 'patient' || cur.openOffer === null) throw new InvalidTransitionError();
        const offer = await this.readOffer(tx, cur.openOffer.id);
        await this.declineLocked(tx, meta, offer);
      }
      const u = await tx.query(
        `UPDATE scheduling.waitlist_entry SET status = 'cancelled', cancel_reason = $2 WHERE id = $1::uuid AND status = 'active' RETURNING id`,
        [cur.id, aud === 'staff' ? 'staff' : 'patient'],
      );
      if (u.rows.length === 0) throw new InvalidTransitionError();
      await record(this.deps, tx, meta, {
        action: 'update',
        resourceType: 'scheduling.waitlist_entry',
        resourceId: cur.id,
        patientId: cur.patientId,
        change: { status: 'cancelled' },
      });
      return await this.readEntry(tx, cur.id);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `GET /waitlist?serviceId&locationId` (staff): the open entries (active or offered) in line order. */
  async listForStaff(
    tx: Tx,
    f: { serviceId?: string; locationId?: string },
  ): Promise<WaitlistEntryView[]> {
    for (const [k, v] of [
      ['serviceId', f.serviceId],
      ['locationId', f.locationId],
    ] as const)
      if (v !== undefined && !isUuid(v)) throw new SchedulingValidationError([k]);
    const r = await tx.query(
      `SELECT e.id, e.patient_id, e.service_id, e.location_id, e.clinician_principal_id, lower(e."window") AS w_from, upper(e."window") AS w_to,
              e.status, e.cancel_reason, e.position_at, e.row_version, o.id AS offer_id, o.expires_at AS offer_expires_at,
              p.given_name, p.family_name
         FROM scheduling.waitlist_entry e
         LEFT JOIN scheduling.waitlist_offer o ON o.waitlist_entry_id = e.id AND o.status = 'offered'
         LEFT JOIN patient.patient p ON p.id = e.patient_id
        WHERE e.status IN ('active', 'offered') AND ($1::uuid IS NULL OR e.service_id = $1::uuid)
          AND ($2::uuid IS NULL OR e.location_id = $2::uuid OR e.location_id IS NULL)
        ORDER BY e.service_id, e.position_at, e.id LIMIT 500`,
      [f.serviceId?.toLowerCase() ?? null, f.locationId?.toLowerCase() ?? null],
    );
    return (r.rows as Row[]).map(entryView);
  }

  // ===== the freed slot and its candidates (job `scheduling.offer_waitlist`, organisation scope) ======================

  /**
   * The slot a freed occupancy leaves, or undefined when there is nothing to offer: the occupancy is not in a freed state, it was an
   * overbook row, it has started, or somebody already holds or has the time (an earlier offer is open, a patient booked it).
   */
  async freedSlot(tx: Tx, occupancyId: string): Promise<FreedSlot | undefined> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    if (!isUuid(occupancyId)) return undefined;
    const r = (
      await tx.query(
        `SELECT o.id, o.organisation_id, o.location_id, o.clinician_principal_id, o.room_id, lower(o.period) AS starts_at,
                upper(o.period) AS ends_at, o.period, o.status, o.overbook, r.service_id, r.mode
           FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id = o.id WHERE o.id = $1::uuid`,
        [occupancyId.toLowerCase()],
      )
    ).rows[0] as Row | undefined;
    if (r === undefined || !FREED.includes(String(r['status'])) || r['overbook'] === true)
      return undefined;
    if (new Date(iso(r['starts_at'])).getTime() <= this.now().getTime()) return undefined;
    const busy = await tx.query(
      `SELECT 1 FROM scheduling.slot_occupancy x
        WHERE x.id <> $1::uuid AND x.status = ANY($4::text[]) AND NOT x.overbook
          AND NOT (x.status = 'held' AND x.expires_at < now()) AND x.period && $3::tstzrange
          AND (x.clinician_principal_id = $2::uuid OR ($5::uuid IS NOT NULL AND x.room_id = $5::uuid)) LIMIT 1`,
      [
        occupancyId.toLowerCase(),
        r['clinician_principal_id'],
        range(iso(r['starts_at']), iso(r['ends_at'])),
        ACTIVE,
        r['room_id'],
      ],
    );
    if (busy.rows.length > 0) return undefined;
    return {
      occupancyId: String(r['id']),
      organisationId: String(r['organisation_id']),
      locationId: String(r['location_id']),
      clinicianId: String(r['clinician_principal_id']),
      roomId: r['room_id'] === null ? null : String(r['room_id']),
      serviceId: String(r['service_id']),
      mode: r['mode'] as 'in_person' | 'video',
      startsAt: iso(r['starts_at']),
      endsAt: iso(r['ends_at']),
    };
  }

  /** The first entries in line that fit the slot, `position_at` order, excluding entries already offered this very slot (a lapsed or declined one). */
  async candidates(tx: Tx, slot: FreedSlot): Promise<OfferCandidate[]> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    const r = await tx.query(
      `SELECT e.id, e.patient_id, e.service_id
         FROM scheduling.waitlist_entry e
        WHERE e.status = 'active' AND e.service_id = $1::uuid
          AND (e.location_id IS NULL OR e.location_id = $2::uuid)
          AND (e.clinician_principal_id IS NULL OR e.clinician_principal_id = $3::uuid)
          AND e."window" @> $4::tstzrange
          AND NOT EXISTS (SELECT 1 FROM scheduling.waitlist_offer w JOIN scheduling.slot_occupancy wo ON wo.id = w.occupancy_id
                           WHERE w.waitlist_entry_id = e.id AND wo.clinician_principal_id = $3::uuid AND wo.period = $4::tstzrange)
        ORDER BY e.position_at, e.id LIMIT $5::int`,
      [
        slot.serviceId,
        slot.locationId,
        slot.clinicianId,
        range(slot.startsAt, slot.endsAt),
        CANDIDATES,
      ],
    );
    return (r.rows as Row[]).map((x) => ({
      entryId: String(x['id']),
      patientId: String(x['patient_id']),
      serviceId: String(x['service_id']),
    }));
  }

  /** Open offers on a freed occupancy whose time has run out: the sweep expired the hold before the offer job did. Organisation scope. */
  async lapsedOffersOn(
    tx: Tx,
    occupancyId: string,
  ): Promise<{ offerId: string; patientId: string }[]> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    const r = await tx.query(
      `SELECT id, patient_id FROM scheduling.waitlist_offer WHERE occupancy_id = $1::uuid AND status = 'offered' AND expires_at <= now()`,
      [occupancyId],
    );
    return (r.rows as Row[]).map((x) => ({
      offerId: String(x['id']),
      patientId: String(x['patient_id']),
    }));
  }

  // ===== one offer (patients scope, system) ============================================================================

  /**
   * Offers the slot to one entry's patient, in a transaction of a patients-scope job for exactly that patient. The hold is
   * `scheduling.hold` of the booking core with `bookedVia = waitlist` and the hold life set to the offer time; every refusal the hold can
   * give for this patient (BR-04, overlap, licensing, lead time, hours) skips to the next entry, `slot_taken` ends the job.
   */
  async offerToCandidate(
    tx: Tx,
    meta: FlowMeta,
    slot: FreedSlot,
    cand: OfferCandidate,
  ): Promise<OfferOutcome> {
    if (tx.scope.audience !== 'system' || tx.scope.jobScope !== 'patients')
      throw new SchedulingScopeError();
    const entry = (
      await tx.query(
        `SELECT status FROM scheduling.waitlist_entry WHERE id = $1::uuid AND patient_id = $2::uuid`,
        [cand.entryId, cand.patientId],
      )
    ).rows[0] as Row | undefined;
    if (entry === undefined || entry['status'] !== 'active')
      return { outcome: 'skipped', reason: 'entry_not_active' };

    // Who the booking is recorded for: the patient's own portal account. A patient without one cannot accept an offer.
    const link = (
      await tx.query(
        `SELECT principal_id FROM identity.patient_link WHERE patient_id = $1::uuid AND kind = 'self' ORDER BY linked_at, principal_id LIMIT 1`,
        [cand.patientId],
      )
    ).rows[0] as Row | undefined;
    if (link === undefined) return { outcome: 'skipped', reason: 'no_portal_account' };
    let patientState: string | null = null;
    if (slot.mode === 'video') {
      const p = (
        await tx.query(`SELECT state_code FROM patient.patient WHERE id = $1::uuid`, [
          cand.patientId,
        ])
      ).rows[0] as Row | undefined;
      patientState = p?.['state_code'] === null || p === undefined ? null : String(p['state_code']);
      if (patientState === null) return { outcome: 'skipped', reason: 'no_state' };
    }

    const offerMinutes = await this.offerMinutes(tx, slot);
    const core = new SchedulingCoreService({
      audit: this.deps.audit,
      organisation: {
        bookingPolicy: async (t, serviceId, locationId) => ({
          ...(await this.deps.organisation.bookingPolicy(t, serviceId, locationId)),
          holdMinutes: offerMinutes,
        }),
        settingOrNull: (t, key, locationId) =>
          this.deps.organisation.settingOrNull(t, key, locationId),
      },
      availability: this.deps.availability,
      ...(this.deps.queue === undefined ? {} : { queue: this.deps.queue }),
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
    });
    const requestId = meta.requestId ?? randomUUID();

    await tx.query('SAVEPOINT offer_try');
    try {
      const held = await core.hold(
        tx,
        { requestId, ip: null, userAgent: null },
        {
          patientId: cand.patientId,
          serviceId: cand.serviceId,
          locationId: slot.locationId,
          clinicianId: slot.clinicianId,
          roomId: slot.roomId,
          startsAt: slot.startsAt,
          mode: slot.mode,
          patientState,
          onBehalfOfPrincipalId: String(link['principal_id']),
        },
        'waitlist',
      );
      const offerId = uuidv7();
      await tx.query(
        `INSERT INTO scheduling.waitlist_offer (id, organisation_id, waitlist_entry_id, patient_id, occupancy_id, status, expires_at)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, 'offered', $5::timestamptz)`,
        [offerId, cand.entryId, cand.patientId, held.reservationId, held.expiresAt],
      );
      const moved = await tx.query(
        `UPDATE scheduling.waitlist_entry SET status = 'offered' WHERE id = $1::uuid AND status = 'active' RETURNING id`,
        [cand.entryId],
      );
      if (moved.rows.length === 0) {
        await tx.query('ROLLBACK TO SAVEPOINT offer_try');
        return { outcome: 'skipped', reason: 'entry_not_active' };
      }
      const tz = (
        await tx.query(`SELECT time_zone FROM organisation.location WHERE id = $1::uuid`, [
          slot.locationId,
        ])
      ).rows[0] as Row;
      await this.deps.notifications.send(tx, {
        templateKey: 'waitlist_offer',
        recipientRef: `patient:${cand.patientId}`,
        variables: {
          start_at: slot.startsAt,
          time_zone: String(tz['time_zone']),
          offer_expires_at: held.expiresAt,
          portal_link: this.deps.portalUrl,
        },
        dedupeKey: `waitlist_offer:${offerId}`,
      });
      await this.deps.queue?.enqueue(
        tx,
        'scheduling.expire_offer',
        { offerId, patientId: cand.patientId },
        { runAt: new Date(held.expiresAt), jobKey: `expire_offer_${offerId}` },
      );
      await record(
        this.deps,
        tx,
        { ...meta, requestId },
        {
          action: 'create',
          resourceType: 'scheduling.waitlist_offer',
          resourceId: offerId,
          patientId: cand.patientId,
          locationId: slot.locationId,
          change: { reservationId: held.reservationId },
        },
      );
      await this.deps.queue?.publish(tx, 'scheduling.waitlist_offered', {
        offerId,
        patientId: cand.patientId,
      });
      await tx.query('RELEASE SAVEPOINT offer_try');
      return { outcome: 'offered', offerId };
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT offer_try');
      if (e instanceof SlotTakenError) return { outcome: 'slot_gone' };
      if (
        e instanceof LeadTimeError ||
        e instanceof MaxFutureReachedError ||
        e instanceof OverlappingAppointmentError ||
        e instanceof LicensingRefusedError ||
        e instanceof OutsideHoursError ||
        e instanceof PatientMergedError ||
        e instanceof SchedulingValidationError
      )
        return { outcome: 'skipped', reason: (e as { code?: string }).code ?? e.name };
      throw e;
    }
  }

  /** The offer time (Setting `waitlist_offer_minutes`): 30 minutes, 15 when the slot starts within 24 hours. Read from the stored setting, never from code. */
  private async offerMinutes(tx: Tx, slot: FreedSlot): Promise<number> {
    const s = await this.deps.organisation.setting<{ default: number; within_24h: number }>(
      tx,
      'waitlist_offer_minutes',
      slot.locationId,
    );
    const within = new Date(slot.startsAt).getTime() - this.now().getTime() < 24 * 3_600_000;
    return within ? s.within_24h : s.default;
  }

  // ===== lapse (job `scheduling.expire_offer`, patients scope, system) ================================================

  /**
   * An offer whose time has run out: the hold is released, the offer is `expired`, the entry returns to `active` (it keeps its place and is
   * not offered this slot again) and `slot_freed` offers the slot to the next entry. Ends without writing when the offer is not due yet,
   * was decided meanwhile, or is not visible to this scope (`gone`: its patient was merged, the job runs again under the survivor).
   * Lock order: patient root, then the occupancy row (inside `set_status`), then the offer, the same as accept.
   */
  async lapseOffer(tx: Tx, meta: FlowMeta, offerId: string): Promise<LapseOutcome> {
    if (tx.scope.audience !== 'system') throw new SchedulingScopeError();
    if (!isUuid(offerId)) return 'gone';
    const o0 = (await tx.query(`${OFFER_SQL} WHERE w.id = $1::uuid`, [offerId.toLowerCase()]))
      .rows[0] as Row | undefined;
    if (o0 === undefined) return 'gone';
    if (o0['status'] !== 'offered') return 'already_decided';
    if (o0['lapsed'] !== true) return 'not_due';
    const patientId = String(o0['patient_id']);
    const occupancyId = String(o0['occupancy_id']);
    try {
      await tx.lockPatients([patientId], 'key_share');
      // Release the hold. Another transaction may have moved it already (accepted, swept, cancelled): then there is nothing to release.
      await tx.query('SAVEPOINT lapse_release');
      let released = false;
      try {
        await tx.query(`SELECT scheduling.set_status($1::uuid, 'held', 'expired')`, [occupancyId]);
        released = true;
        await tx.query('RELEASE SAVEPOINT lapse_release');
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'PS001') throw e;
        await tx.query('ROLLBACK TO SAVEPOINT lapse_release');
      }
      const occ = (
        await tx.query(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1::uuid`, [
          occupancyId,
        ])
      ).rows[0] as Row | undefined;
      if (occ?.['status'] === 'confirmed' || occ?.['status'] === 'checked_in')
        return 'already_decided';
      const u = await tx.query(
        `UPDATE scheduling.waitlist_offer SET status = 'expired', decided_at = now() WHERE id = $1::uuid AND status = 'offered' AND expires_at <= now() RETURNING id`,
        [o0['id']],
      );
      if (u.rows.length === 0) return 'already_decided';
      await tx.query(
        `UPDATE scheduling.waitlist_entry SET status = 'active' WHERE id = $1::uuid AND status = 'offered'`,
        [o0['waitlist_entry_id']],
      );
      await record(this.deps, tx, meta, {
        action: 'update',
        resourceType: 'scheduling.waitlist_offer',
        resourceId: String(o0['id']),
        patientId,
        locationId: String(o0['location_id']),
        change: { status: 'expired', holdReleased: released },
      });
      await this.deps.queue?.publish(tx, 'scheduling.slot_freed', { occupancyId });
      return 'expired';
    } catch (e) {
      translateDbError(e);
    }
  }

  // ===== accept and decline (patient, proxy) ===========================================================================

  async readOffer(tx: Tx, offerId: string): Promise<OfferView> {
    if (!isUuid(offerId)) throw new ReservationNotFoundError();
    const r = await tx.query(`${OFFER_SQL} WHERE w.id = $1::uuid`, [offerId.toLowerCase()]);
    if (r.rows[0] === undefined) throw new ReservationNotFoundError();
    return offerView(r.rows[0] as Row);
  }

  /**
   * `POST /waitlist-offers/{offerId}/accept`. The first acceptance inside the window wins: it confirms the hold; a later one, or one after the
   * time, is `409 scheduling.offer_expired` ("no longer available"). Accepting an offer that this patient already accepted returns it again.
   */
  async acceptOffer(tx: Tx, meta: FlowMeta, offerId: string): Promise<OfferView> {
    if (tx.scope.audience !== 'patient') throw new SchedulingScopeError();
    const first = await this.readOffer(tx, offerId);
    try {
      // The strongest root lock this transaction needs (ensure_care_relationship writes), before any child-row write (25.2 rule 1).
      await tx.lockPatients([first.patientId], 'no_key_update');
      const cur = (await tx.query(`${OFFER_SQL} WHERE w.id = $1::uuid`, [first.id])).rows[0] as
        Row | undefined;
      if (cur === undefined) throw new ReservationNotFoundError();
      if (cur['status'] === 'accepted') return offerView(cur);
      if (cur['status'] !== 'offered' || cur['lapsed'] === true) throw new OfferExpiredError();

      await tx.query('SAVEPOINT accept_confirm');
      let result: string;
      try {
        result = String(
          (
            (
              await tx.query(
                `SELECT scheduling.set_status($1::uuid, 'held', 'confirmed') AS result`,
                [first.reservationId],
              )
            ).rows[0] as Row
          )['result'],
        );
        await tx.query('RELEASE SAVEPOINT accept_confirm');
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'PS001') throw e;
        // The hold left `held` between our read and the lock: another acceptance won, or the offer lapsed.
        await tx.query('ROLLBACK TO SAVEPOINT accept_confirm');
        const again = (await tx.query(`${OFFER_SQL} WHERE w.id = $1::uuid`, [first.id])).rows[0] as
          Row | undefined;
        if (again !== undefined && again['status'] === 'accepted') return offerView(again);
        throw new OfferExpiredError();
      }
      if (result !== 'ok') throw new OfferExpiredError();

      await tx.callScopeOwner(
        scopeOwnerFn('ensure_care_relationship'),
        [meta.requestId ?? randomUUID(), first.patientId, first.locationId, 'booking'],
        [first.patientId],
      );
      const u = await tx.query(
        `UPDATE scheduling.waitlist_offer SET status = 'accepted', decided_at = now() WHERE id = $1::uuid AND status = 'offered' RETURNING id`,
        [first.id],
      );
      if (u.rows.length === 0) throw new OfferExpiredError();
      await tx.query(
        `UPDATE scheduling.waitlist_entry SET status = 'fulfilled' WHERE id = $1::uuid AND status = 'offered'`,
        [first.waitlistEntryId],
      );
      await record(this.deps, tx, meta, {
        action: 'update',
        resourceType: 'scheduling.waitlist_offer',
        resourceId: first.id,
        patientId: first.patientId,
        locationId: first.locationId,
        change: { status: 'accepted', reservationId: first.reservationId },
      });
      // The appointment is now confirmed: the confirmation message, reminders and the pre-visit invitation follow, as for any confirm (25.1).
      await this.deps.queue?.publish(tx, 'scheduling.reservation_confirmed', {
        reservationId: first.reservationId,
        patientId: first.patientId,
      });
      return await this.readOffer(tx, first.id);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `POST /waitlist-offers/{offerId}/decline`: the hold is released and the next entry gets the slot. Declining twice is the same answer. */
  async declineOffer(tx: Tx, meta: FlowMeta, offerId: string): Promise<OfferView> {
    if (tx.scope.audience !== 'patient') throw new SchedulingScopeError();
    const first = await this.readOffer(tx, offerId);
    try {
      await tx.lockPatients([first.patientId], 'key_share');
      return await this.declineLocked(tx, meta, await this.readOffer(tx, first.id));
    } catch (e) {
      translateDbError(e);
    }
  }

  /** The decline, inside a transaction that already holds the patient root lock. */
  private async declineLocked(tx: Tx, meta: FlowMeta, offer: OfferView): Promise<OfferView> {
    if (offer.status === 'declined') return offer;
    if (offer.status !== 'offered') throw new OfferExpiredError();
    // N-2 (25.1): the reservation's own field first; once the occupancy is in a K state the reservation accepts no update.
    await tx.query(
      `UPDATE scheduling.slot_reservation SET cancel_reason = $2 WHERE id = $1::uuid AND cancel_reason IS NULL`,
      [offer.reservationId, 'Waitlist offer declined'],
    );
    await tx.query('SAVEPOINT decline_release');
    try {
      await tx.query(`SELECT scheduling.set_status($1::uuid, 'held', 'cancelled_patient')`, [
        offer.reservationId,
      ]);
      await tx.query('RELEASE SAVEPOINT decline_release');
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== 'PS001') throw e;
      await tx.query('ROLLBACK TO SAVEPOINT decline_release');
      // Not held any more: accepted elsewhere, or the sweep expired it. An accepted offer cannot be declined; an expired hold can be
      // recorded as declined (the patient's answer stands).
      const st = (
        await tx.query(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1::uuid`, [
          offer.reservationId,
        ])
      ).rows[0] as Row | undefined;
      if (st?.['status'] === 'confirmed' || st?.['status'] === 'checked_in')
        throw new OfferExpiredError();
    }
    const u = await tx.query(
      `UPDATE scheduling.waitlist_offer SET status = 'declined', decided_at = now() WHERE id = $1::uuid AND status = 'offered' RETURNING id`,
      [offer.id],
    );
    if (u.rows.length === 0) throw new OfferExpiredError();
    await tx.query(
      `UPDATE scheduling.waitlist_entry SET status = 'active' WHERE id = $1::uuid AND status = 'offered'`,
      [offer.waitlistEntryId],
    );
    await record(this.deps, tx, meta, {
      action: 'update',
      resourceType: 'scheduling.waitlist_offer',
      resourceId: offer.id,
      patientId: offer.patientId,
      locationId: offer.locationId,
      change: { status: 'declined' },
    });
    await this.deps.queue?.publish(tx, 'scheduling.slot_freed', {
      occupancyId: offer.reservationId,
    });
    return { ...offer, status: 'declined', decidedAt: this.now().toISOString() };
  }
}
