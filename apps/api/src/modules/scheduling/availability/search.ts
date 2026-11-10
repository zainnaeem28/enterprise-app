// Slot search and the availability port of the booking core (ARCHITECTURE 22.8, 29.2, 29.3, 35.2; ticket BE-12).
//
//   offered slots = the doctor's template  minus  active bookings (doctor, and room where the rule names one)
//                                          minus  blocked time and leave  minus  Google busy time
//
// Four reads decide the answer (35.2): the template windows (one statement: templates x rules x location time zone, expanded per
// local date by PostgreSQL so daylight-saving changes are the database's), the occupancy rows, the busy blocks (with the last sync of
// each doctor in the same statement) and the blocked times. No external call is made: Google is never called in the request path
// (X-03); busy data older than `calendar_stale_minutes` is still used (it is the last known) and is flagged in the answer, never
// silently trusted. Everything runs in the caller's scoped transaction, so a patient reads only what the patient audience may read
// (the directory views for services, clinicians and service locations).
import type { Tx } from '@ehr/kernel';
import type { OrganisationService } from '../../organisation/index.js';
import { SchedulingValidationError } from '../core/errors.js';
import { isUuid } from '../core/ids.js';
import type { AvailabilityPort, SlotQuery, VisitMode } from '../core/types.js';
import type { SearchInput, SearchResult, Slot } from './types.js';

type Row = Record<string, unknown>;

/** The statuses that occupy a doctor's time (the exclusion constraints' predicate, 0900). */
const ACTIVE = ['held', 'confirmed', 'checked_in', 'in_consultation', 'completed'] as const;

/** A range of one search is at most 31 days (29.2). */
export const MAX_SEARCH_DAYS = 31;
/** Upper bound of slots in one answer; the earliest are returned. */
export const MAX_SLOTS = 2000;
const ALTERNATIVE_DAYS = 14;

interface Window {
  clinicianId: string;
  locationId: string;
  ruleId: string;
  roomId: string | null;
  overbookable: boolean;
  localDate: string;
  start: number;
  end: number;
}
interface Interval {
  start: number;
  end: number;
}

/** A booking in a room: whose time it is, so that the same doctor's further patients do not block each other (HEAAA-632 R3, R4). */
interface RoomInterval extends Interval {
  clinicianId: string;
}

export interface SearchDeps {
  organisation: Pick<OrganisationService, 'bookingPolicy' | 'setting'>;
  now?: () => Date;
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const overlaps = (list: readonly Interval[] | undefined, s: number, e: number): boolean =>
  list !== undefined && list.some((i) => i.start < e && s < i.end);

function parseInstant(name: string, v: unknown, bad: string[]): number {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(t) || typeof v !== 'string' || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v))
    bad.push(name);
  return t;
}

/** The slot search and the port the booking core asks (hold validation, alternatives). */
export class AvailabilitySearch implements AvailabilityPort {
  constructor(private readonly deps: SearchDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ===== POST /availability/search (29.2, 29.3) ========================================================================

  async search(tx: Tx, input: SearchInput): Promise<SearchResult> {
    const aud = tx.scope.audience;
    if (aud !== 'patient' && aud !== 'staff') throw new SchedulingValidationError(['audience']);
    const bad: string[] = [];
    const serviceId = isUuid(input.serviceId)
      ? input.serviceId.toLowerCase()
      : (bad.push('serviceId'), '');
    const locationId =
      input.locationId === undefined || input.locationId === null
        ? null
        : isUuid(input.locationId)
          ? input.locationId.toLowerCase()
          : (bad.push('locationId'), null);
    const clinicianId =
      input.clinicianId === undefined || input.clinicianId === null
        ? null
        : isUuid(input.clinicianId)
          ? input.clinicianId.toLowerCase()
          : (bad.push('clinicianId'), null);
    if (input.mode !== 'in_person' && input.mode !== 'video') bad.push('mode');
    const from = parseInstant('from', input.from, bad);
    const to = parseInstant('to', input.to, bad);
    if (
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      (to <= from || to - from > MAX_SEARCH_DAYS * 86_400_000)
    )
      bad.push('to');
    if (input.includeOverbook !== undefined && typeof input.includeOverbook !== 'boolean')
      bad.push('includeOverbook');
    // includeOverbook is a staff option (29.3); a patient who sends it gets a validation error, not a quietly different answer.
    if (input.includeOverbook === true && aud !== 'staff') bad.push('includeOverbook');
    if (bad.length > 0) throw new SchedulingValidationError(bad);

    const r = await this.collect(tx, {
      serviceId,
      locationId,
      clinicianId,
      mode: input.mode,
      from,
      to,
      includeOverbook: input.includeOverbook === true,
      applyLead: aud !== 'staff',
    });
    const slots = r.slots.slice(0, MAX_SLOTS).map((s): Slot => ({
      startsAt: new Date(s.start).toISOString(),
      endsAt: new Date(s.end).toISOString(),
      clinicianId: s.clinicianId,
      locationId: s.locationId,
      mode: input.mode,
      ...(aud === 'staff' && s.overbook ? { overbook: true as const } : {}),
    }));
    return { slots, availabilityStale: r.stale };
  }

  // ===== the port of the booking core (core/types.ts, D4) ================================================================

  /**
   * Is `q` a slot of the doctor's template? The period must lie inside a template window of the right place, service and mode, on the
   * slot grid of the service (a multiple of its duration from the window's start), clear of blocked time, leave and busy time.
   * Overlap with another booking is the database's to decide (the exclusion constraint), except in an overbookable window: where the
   * rule is overbookable and the stored cap is 2 or more, every booking (the first included) is an overbook row, so the answer always
   * names the slot and `scheduling.occupy` counts all the doctor's active rows in the slot against the cap (HEAAA-632 D-F11-T1, R2).
   */
  async resolve(
    tx: Tx,
    q: SlotQuery,
  ): Promise<
    | { ok: true; overbook?: { sessionKey: string } }
    | { ok: false; code: 'scheduling.outside_hours' }
  > {
    const from = q.startsAt.getTime();
    const to = q.endsAt.getTime();
    const dur = to - from;
    // The doctor's time is serialised first (the `dr:` lock of 25.2: after the patient locks, before the occupancy insert, which takes
    // it again). Leave, blocked time and booking all change a doctor's diary under this lock, so what is read below cannot be
    // overtaken by a leave that commits between this check and the insert (TC-DR-02).
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('dr:' || $1::text))`, [q.clinicianId]);
    const windows = await this.windows(tx, {
      serviceId: q.serviceId,
      locationId: q.locationId,
      clinicianId: q.clinicianId,
      mode: q.mode,
      from,
      to,
    });
    const w = windows.find(
      (x) =>
        x.clinicianId === q.clinicianId &&
        x.locationId === q.locationId &&
        x.start <= from &&
        to <= x.end &&
        (from - x.start) % dur === 0 &&
        (q.roomId === null || x.roomId === null || x.roomId === q.roomId),
    );
    if (w === undefined) return { ok: false, code: 'scheduling.outside_hours' };
    const data = await this.conflicts(
      tx,
      [q.clinicianId],
      q.roomId === null ? [] : [q.roomId],
      from,
      to,
    );
    if (
      overlaps(data.blocked.get(q.clinicianId), from, to) ||
      overlaps(data.busy.get(q.clinicianId), from, to)
    )
      return { ok: false, code: 'scheduling.outside_hours' };
    if (!w.overbookable) return { ok: true };
    const cap = (await this.deps.organisation.bookingPolicy(tx, q.serviceId, q.locationId))
      .overbookCapPerSession;
    // A cap of 0 or 1 means no overbooking. The key names the slot for traceability only; the database counts by overlap.
    return cap >= 2
      ? { ok: true, overbook: { sessionKey: `${w.ruleId}:${new Date(from).toISOString()}` } }
      : { ok: true };
  }

  /** Up to five other start times of the same doctor, place, service and mode, as the search would offer them (X-01, X-02). */
  async alternatives(tx: Tx, q: SlotQuery): Promise<string[]> {
    const from = q.startsAt.getTime();
    const r = await this.collect(tx, {
      serviceId: q.serviceId,
      locationId: q.locationId,
      clinicianId: q.clinicianId,
      mode: q.mode,
      from,
      to: from + ALTERNATIVE_DAYS * 86_400_000,
      includeOverbook: false,
      applyLead: tx.scope.audience !== 'staff',
    });
    return r.slots
      .filter((s) => s.start !== from)
      .slice(0, 5)
      .map((s) => new Date(s.start).toISOString());
  }

  // ===== the four reads ================================================================================================

  /**
   * The template windows that touch [from, to): one per rule and local date. `(date + time) AT TIME ZONE zone` is evaluated by
   * PostgreSQL, so a daylight-saving change moves the instant and not the wall-clock time (TC-BK-10). A patient reaches the service,
   * its clinicians and its locations only through the directory views (22.5.1); staff read the tables.
   */
  private async windows(
    tx: Tx,
    c: {
      serviceId: string;
      locationId: string | null;
      clinicianId: string | null;
      mode: VisitMode;
      from: number;
      to: number;
    },
  ): Promise<Window[]> {
    const patient = tx.scope.audience === 'patient';
    const eligible = patient
      ? 'organisation.public_service_clinician'
      : 'organisation.service_clinician';
    const offered = patient
      ? 'organisation.public_service_location'
      : 'organisation.service_location';
    // A clinician is offered only while listed and active (patients: the directory view; staff: the principal row).
    const listed = patient
      ? `JOIN identity.public_clinician pc ON pc.principal_id = t.clinician_principal_id`
      : `JOIN identity.principal pr ON pr.id = t.clinician_principal_id AND pr.realm = 'google' AND pr.status = 'active'`;
    const res = await tx.query(
      `SELECT t.clinician_principal_id AS clinician_id, t.location_id, r.id AS rule_id, r.room_id, r.overbookable,
              to_char(d, 'YYYY-MM-DD') AS local_date,
              ((d::date + r.start_local) AT TIME ZONE l.time_zone) AS win_start,
              ((d::date + r.end_local) AT TIME ZONE l.time_zone) AS win_end
         FROM scheduling.availability_template t
         JOIN scheduling.template_rule r ON r.template_id = t.id
         JOIN organisation.location l ON l.id = t.location_id AND l.active
         JOIN ${eligible} ec ON ec.clinician_principal_id = t.clinician_principal_id AND ec.service_id = $1::uuid
         JOIN ${offered} sl ON sl.service_id = $1::uuid AND sl.location_id = t.location_id
         ${listed}
        CROSS JOIN LATERAL generate_series(
                greatest(t.valid_from, (($4::timestamptz AT TIME ZONE l.time_zone)::date))::timestamp,
                least(coalesce(t.valid_to, (($5::timestamptz AT TIME ZONE l.time_zone)::date)), (($5::timestamptz AT TIME ZONE l.time_zone)::date))::timestamp,
                interval '1 day') AS d
        WHERE t.status = 'active'
          AND extract(dow FROM d) = r.weekday
          AND (r.service_ids IS NULL OR $1::uuid = ANY (r.service_ids))
          AND (r.mode = 'either' OR r.mode = $6::text)
          AND ($2::uuid IS NULL OR t.clinician_principal_id = $2::uuid)
          AND ($3::uuid IS NULL OR t.location_id = $3::uuid)
          AND ((d::date + r.end_local) AT TIME ZONE l.time_zone) > $4::timestamptz
          AND ((d::date + r.start_local) AT TIME ZONE l.time_zone) < $5::timestamptz`,
      [
        c.serviceId,
        c.clinicianId,
        c.locationId,
        new Date(c.from).toISOString(),
        new Date(c.to).toISOString(),
        c.mode,
      ],
    );
    return res.rows.map((x) => {
      const r = x as Row;
      return {
        clinicianId: String(r['clinician_id']),
        locationId: String(r['location_id']),
        ruleId: String(r['rule_id']),
        roomId: r['room_id'] === null ? null : String(r['room_id']),
        overbookable: r['overbookable'] === true,
        localDate: String(r['local_date']),
        start: ms(r['win_start']),
        end: ms(r['win_end']),
      };
    });
  }

  /** Occupancy, busy blocks (with each doctor's last sync) and blocked times that touch [from, to) for these doctors and rooms. */
  private async conflicts(
    tx: Tx,
    clinicians: readonly string[],
    rooms: readonly string[],
    from: number,
    to: number,
  ): Promise<{
    booked: Map<string, Interval[]>;
    roomBooked: Map<string, RoomInterval[]>;
    busy: Map<string, Interval[]>;
    lastSync: Map<string, number>;
    blocked: Map<string, Interval[]>;
  }> {
    const range = `[${new Date(from).toISOString()},${new Date(to).toISOString()})`;
    const push = (m: Map<string, Interval[]>, k: string, i: Interval): void => {
      const l = m.get(k);
      if (l === undefined) m.set(k, [i]);
      else l.push(i);
    };
    const booked = new Map<string, Interval[]>();
    const roomBooked = new Map<string, RoomInterval[]>();
    // A lapsed hold no longer occupies anything (the inserting transaction expires it, 25.1): it is not read here either.
    const occ = await tx.query(
      `SELECT clinician_principal_id AS clinician_id, room_id, lower(period) AS s, upper(period) AS e
         FROM scheduling.slot_occupancy
        WHERE status = ANY($1::text[]) AND NOT (status = 'held' AND expires_at < now()) AND period && $2::tstzrange
          AND (clinician_principal_id = ANY($3::uuid[]) OR room_id = ANY($4::uuid[]))`,
      [[...ACTIVE], range, [...clinicians], [...rooms]],
    );
    for (const x of occ.rows) {
      const r = x as Row;
      const i = { start: ms(r['s']), end: ms(r['e']) };
      const cid = String(r['clinician_id']);
      if (clinicians.includes(cid)) push(booked, cid, i);
      if (r['room_id'] !== null) {
        const rid = String(r['room_id']);
        const l = roomBooked.get(rid);
        const ri = { ...i, clinicianId: cid };
        if (l === undefined) roomBooked.set(rid, [ri]);
        else l.push(ri);
      }
    }

    const busy = new Map<string, Interval[]>();
    const lastSync = new Map<string, number>();
    const bb = await tx.query(
      `WITH fresh AS (
         SELECT clinician_principal_id, max(synced_at) AS last_sync FROM scheduling.busy_block
          WHERE clinician_principal_id = ANY($1::uuid[]) GROUP BY clinician_principal_id)
       SELECT f.clinician_principal_id AS clinician_id, f.last_sync, lower(b.period) AS s, upper(b.period) AS e
         FROM fresh f
         LEFT JOIN scheduling.busy_block b ON b.clinician_principal_id = f.clinician_principal_id AND b.period && $2::tstzrange`,
      [[...clinicians], range],
    );
    for (const x of bb.rows) {
      const r = x as Row;
      const cid = String(r['clinician_id']);
      lastSync.set(cid, ms(r['last_sync']));
      if (r['s'] !== null) push(busy, cid, { start: ms(r['s']), end: ms(r['e']) });
    }

    const blocked = new Map<string, Interval[]>();
    const bt = await tx.query(
      `SELECT clinician_principal_id AS clinician_id, lower(period) AS s, upper(period) AS e
         FROM scheduling.blocked_time WHERE clinician_principal_id = ANY($1::uuid[]) AND period && $2::tstzrange`,
      [[...clinicians], range],
    );
    for (const x of bt.rows) {
      const r = x as Row;
      push(blocked, String(r['clinician_id']), { start: ms(r['s']), end: ms(r['e']) });
    }
    return { booked, roomBooked, busy, lastSync, blocked };
  }

  // ===== the search proper ================================================================================================

  private async collect(
    tx: Tx,
    c: {
      serviceId: string;
      locationId: string | null;
      clinicianId: string | null;
      mode: VisitMode;
      from: number;
      to: number;
      includeOverbook: boolean;
      applyLead: boolean;
    },
  ): Promise<{
    slots: (Interval & { clinicianId: string; locationId: string; overbook: boolean })[];
    stale: boolean;
  }> {
    const patient = tx.scope.audience === 'patient';
    const svc = (
      await tx.query(
        patient
          ? `SELECT duration_min, mode FROM organisation.public_service WHERE id = $1::uuid`
          : `SELECT duration_min, mode FROM organisation.service WHERE id = $1::uuid AND active`,
        [c.serviceId],
      )
    ).rows[0] as Row | undefined;
    if (svc === undefined) throw new SchedulingValidationError(['serviceId']);
    if (svc['mode'] !== 'either' && svc['mode'] !== c.mode)
      throw new SchedulingValidationError(['mode']);
    // The grid step is the service's duration. `buffer_min` is not applied: a patient transaction cannot read it (22.5.1; the
    // organisation README N-BE03-4 asks the Architect how it is to reach scheduling), so one grid serves both audiences.
    const dur = Number(svc['duration_min']) * 60_000;

    const windows = await this.windows(tx, c);
    if (windows.length === 0) return { slots: [], stale: false };

    const clinicians = [...new Set(windows.map((w) => w.clinicianId))];
    const rooms = [...new Set(windows.flatMap((w) => (w.roomId === null ? [] : [w.roomId])))];
    const data = await this.conflicts(tx, clinicians, rooms, c.from, c.to);

    const threshold =
      Number(await this.deps.organisation.setting<number>(tx, 'calendar_stale_minutes')) * 60_000;
    const nowMs = this.now().getTime();
    // Busy data older than the threshold: used as the last known and reported, never silently (X-03, RA-R1-04).
    const stale = clinicians.some((id) => {
      const last = data.lastSync.get(id);
      return last !== undefined && nowMs - last > threshold;
    });

    const leadByLocation = new Map<string, { leadMs: number; cap: number }>();
    for (const loc of new Set(windows.map((w) => w.locationId))) {
      const p = await this.deps.organisation.bookingPolicy(tx, c.serviceId, loc);
      leadByLocation.set(loc, { leadMs: p.leadTimeMin * 60_000, cap: p.overbookCapPerSession });
    }

    const out = new Map<
      string,
      Interval & { clinicianId: string; locationId: string; overbook: boolean }
    >();
    for (const w of windows) {
      const pol = leadByLocation.get(w.locationId) as { leadMs: number; cap: number };
      const earliest = Math.max(c.from, nowMs + (c.applyLead ? pol.leadMs : 0) + 1);
      let k = w.start >= earliest ? 0 : Math.ceil((earliest - w.start) / dur);
      for (; w.start + (k + 1) * dur <= w.end; k++) {
        const s = w.start + k * dur;
        const e = s + dur;
        if (e > c.to) break;
        const key = `${w.clinicianId}|${s}`;
        if (out.has(key)) continue;
        if (
          overlaps(data.blocked.get(w.clinicianId), s, e) ||
          overlaps(data.busy.get(w.clinicianId), s, e)
        )
          continue;
        // The period overlap is authoritative (HEAAA-632 N1): `own` counts the doctor's active rows that overlap this start, overbook
        // rows included; a room held by another clinician's row, overbook or not, is never offered (R4).
        const own = (data.booked.get(w.clinicianId) ?? []).filter(
          (x) => x.start < e && s < x.end,
        ).length;
        const roomTaken =
          w.roomId !== null &&
          (data.roomBooked.get(w.roomId) ?? []).some(
            (x) => x.clinicianId !== w.clinicianId && x.start < e && s < x.end,
          );
        if (roomTaken) continue;
        if (own === 0) {
          out.set(key, {
            start: s,
            end: e,
            clinicianId: w.clinicianId,
            locationId: w.locationId,
            overbook: false,
          });
        } else if (c.includeOverbook && w.overbookable && pol.cap >= 2 && own < pol.cap) {
          out.set(key, {
            start: s,
            end: e,
            clinicianId: w.clinicianId,
            locationId: w.locationId,
            overbook: true,
          });
        }
      }
    }
    const slots = [...out.values()].sort(
      (a, b) =>
        a.start - b.start ||
        (a.clinicianId < b.clinicianId ? -1 : a.clinicianId > b.clinicianId ? 1 : 0),
    );
    return { slots, stale };
  }
}
