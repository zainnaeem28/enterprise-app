// Availability management (ARCHITECTURE 22.8, 29.3, 29.4; ticket BE-12): a doctor's weekly templates, leave and blocked time, and the
// roster of a location. Every method runs in the caller's scoped transaction. Authorization is decided here and again by the
// database: a google-realm doctor manages only their own template and blocked time (T-CONF-STAFF(own)), a front-desk lead only the
// roster of their own locations and never `compliance_on_call` (T-CONF-STAFF(loc)); the admin realm manages all of it. The API guard
// has already checked the permission. Nothing here cancels or moves an appointment: leave and blocked time over booked appointments
// are reported (counts only) and saved only when the caller acknowledges them.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import { isUuid, uuidv7 } from '../core/ids.js';
import type { RequestMeta } from '../core/types.js';
import {
  AvailabilityNotFoundError,
  ConflictsWithAppointmentsError,
  InvalidTransitionError,
  PreconditionFailedError,
  RosterPrincipalIneligibleError,
  SchedulingScopeError,
  SchedulingValidationError,
} from './errors.js';
import type {
  BlockedKind,
  BlockedTimeInput,
  BlockedTimeView,
  ConflictCounts,
  RosterDuty,
  RosterInput,
  RosterView,
  RuleInput,
  RuleMode,
  RuleView,
  TemplateInput,
  TemplateView,
} from './types.js';

type Row = Record<string, unknown>;

export interface AvailabilityServiceDeps {
  audit: AuditService;
  now?: () => Date;
}

const MAX_RULES = 100;
const MAX_BLOCK_DAYS = 366;
const ROSTER_MAX_DAYS = 366;
/** The doctor duties need this permission through a role held at the location (22.8). */
const DOCTOR_DUTY_PERMISSION = 'clinical.alert.red_flag.receive';
const DUTIES: readonly string[] = ['on_duty_doctor', 'on_call_doctor', 'compliance_on_call'];
const KINDS: readonly string[] = ['leave', 'blocked', 'admin'];
const MODES: readonly string[] = ['in_person', 'video', 'either'];

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const hhmm = (v: unknown): string => String(v).slice(0, 5);

/** `HH:MM` or `HH:MM:00` -> minutes since midnight, or null. */
function minutesOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(v);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}
function validDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}
function instant(v: unknown): number {
  return typeof v === 'string' && /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? Date.parse(v) : Number.NaN;
}

export class AvailabilityService {
  constructor(private readonly deps: AvailabilityServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ===== who may manage what ===========================================================================================

  /**
   * A google-realm staff member manages only their own templates and blocked time; the admin realm manages any clinician's (29.3, 29.4).
   * The route guard resolves the same rule first and writes the denial to the audit trail; the row-level-security policy is the third line.
   */
  private assertClinicianScope(tx: Tx, clinicianId: string): void {
    const s = tx.scope;
    if (s.audience !== 'staff') throw new SchedulingScopeError();
    if (s.realm === 'admin_pool') return;
    if (
      s.realm !== 'google' ||
      s.principalId === undefined ||
      s.principalId.toLowerCase() !== clinicianId.toLowerCase()
    )
      throw new SchedulingScopeError();
  }

  private requireClinician(clinicianId: string): string {
    if (!isUuid(clinicianId)) throw new AvailabilityNotFoundError();
    return clinicianId.toLowerCase();
  }

  private async assertClinicianExists(tx: Tx, clinicianId: string): Promise<void> {
    const r = await tx.query(
      `SELECT 1 FROM identity.principal WHERE id = $1::uuid AND realm = 'google' AND status = 'active'`,
      [clinicianId],
    );
    if (r.rows.length === 0) throw new AvailabilityNotFoundError();
  }

  // ===== availability templates (29.3) ===================================================================================

  async listTemplates(
    tx: Tx,
    clinicianId: string,
    f: { status?: 'active' | 'retired' } = {},
  ): Promise<TemplateView[]> {
    const id = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, id);
    const t = await tx.query(
      `SELECT id, clinician_principal_id, location_id, valid_from, valid_to, status, row_version
         FROM scheduling.availability_template
        WHERE clinician_principal_id = $1::uuid AND ($2::text IS NULL OR status = $2::text)
        ORDER BY valid_from, id`,
      [id, f.status ?? null],
    );
    return this.withRules(tx, t.rows as Row[]);
  }

  async getTemplate(
    tx: Tx,
    clinicianId: string,
    templateId: string,
  ): Promise<TemplateView | undefined> {
    const id = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, id);
    if (!isUuid(templateId)) return undefined;
    const t = await tx.query(
      `SELECT id, clinician_principal_id, location_id, valid_from, valid_to, status, row_version
         FROM scheduling.availability_template WHERE id = $1::uuid AND clinician_principal_id = $2::uuid`,
      [templateId, id],
    );
    return (await this.withRules(tx, t.rows as Row[]))[0];
  }

  async createTemplate(
    tx: Tx,
    meta: RequestMeta,
    clinicianId: string,
    input: TemplateInput,
  ): Promise<TemplateView> {
    const cid = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, cid);
    const v = this.validateTemplate(input);
    await this.assertClinicianExists(tx, cid);
    await this.lockTemplates(tx, cid);
    await this.checkPlace(tx, v.locationId, v.rules);
    await this.checkOverlaps(tx, cid, v, null);
    const id = uuidv7();
    const me = tx.scope.principalId ?? null;
    await tx.query(
      `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from, valid_to, status, created_by)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::date, $5::date, 'active', $6::uuid)`,
      [id, cid, v.locationId, v.validFrom, v.validTo, me],
    );
    await this.insertRules(tx, id, cid, v.rules, me);
    await this.audit(tx, meta, 'scheduling.availability_template', id, v.locationId, {
      op: 'create',
      clinicianId: cid,
      rules: v.rules.length,
    });
    return this.reread(tx, cid, id);
  }

  /** `PUT /clinicians/{id}/availability-templates/{templateId}` (If-Match): replaces place, validity and all rules. */
  async replaceTemplate(
    tx: Tx,
    meta: RequestMeta,
    clinicianId: string,
    templateId: string,
    input: TemplateInput,
    expectedVersion: number,
  ): Promise<TemplateView> {
    const cid = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, cid);
    if (!isUuid(templateId)) throw new AvailabilityNotFoundError();
    const v = this.validateTemplate(input);
    await this.lockTemplates(tx, cid);
    const cur = await this.lockOne(tx, cid, templateId, expectedVersion);
    await this.checkPlace(tx, v.locationId, v.rules);
    await this.checkOverlaps(tx, cid, v, cur.id);
    const me = tx.scope.principalId ?? null;
    await tx.query(
      `UPDATE scheduling.availability_template SET location_id = $2::uuid, valid_from = $3::date, valid_to = $4::date WHERE id = $1::uuid`,
      [cur.id, v.locationId, v.validFrom, v.validTo],
    );
    await tx.query(`DELETE FROM scheduling.template_rule WHERE template_id = $1::uuid`, [cur.id]);
    await this.insertRules(tx, cur.id, cid, v.rules, me);
    await this.audit(tx, meta, 'scheduling.availability_template', cur.id, v.locationId, {
      op: 'replace',
      clinicianId: cid,
      rules: v.rules.length,
    });
    return this.reread(tx, cid, cur.id);
  }

  /** `DELETE /clinicians/{id}/availability-templates/{templateId}`: the template is retired, never removed (history; the next search stops using it). */
  async retireTemplate(
    tx: Tx,
    meta: RequestMeta,
    clinicianId: string,
    templateId: string,
    expectedVersion: number,
  ): Promise<TemplateView> {
    const cid = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, cid);
    if (!isUuid(templateId)) throw new AvailabilityNotFoundError();
    const cur = await this.lockOne(tx, cid, templateId, expectedVersion);
    await tx.query(
      `UPDATE scheduling.availability_template SET status = 'retired' WHERE id = $1::uuid`,
      [cur.id],
    );
    await this.audit(tx, meta, 'scheduling.availability_template', cur.id, cur.locationId, {
      op: 'retire',
      clinicianId: cid,
    });
    return this.reread(tx, cid, cur.id);
  }

  private async lockTemplates(tx: Tx, clinicianId: string): Promise<void> {
    // Two requests for one doctor's templates run one after the other, so the overlap check below cannot be raced.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('tpl:' || $1::text))`, [clinicianId]);
  }

  private async lockOne(
    tx: Tx,
    clinicianId: string,
    templateId: string,
    expectedVersion: number,
  ): Promise<{ id: string; locationId: string }> {
    const r = await tx.query(
      `SELECT id, location_id, status, row_version FROM scheduling.availability_template
        WHERE id = $1::uuid AND clinician_principal_id = $2::uuid FOR UPDATE`,
      [templateId, clinicianId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw new AvailabilityNotFoundError();
    if (Number(row['row_version']) !== expectedVersion) throw new PreconditionFailedError();
    if (row['status'] !== 'active') throw new InvalidTransitionError();
    return { id: String(row['id']), locationId: String(row['location_id']) };
  }

  private async withRules(tx: Tx, templates: Row[]): Promise<TemplateView[]> {
    if (templates.length === 0) return [];
    const ids = templates.map((t) => String(t['id']));
    const r = await tx.query(
      `SELECT id, template_id, weekday, start_local, end_local, service_ids, mode, room_id, overbookable
         FROM scheduling.template_rule WHERE template_id = ANY($1::uuid[]) ORDER BY weekday, start_local, id`,
      [ids],
    );
    const byTemplate = new Map<string, RuleView[]>();
    for (const x of r.rows) {
      const q = x as Row;
      const list = byTemplate.get(String(q['template_id'])) ?? [];
      list.push({
        id: String(q['id']),
        weekday: Number(q['weekday']),
        startLocal: hhmm(q['start_local']),
        endLocal: hhmm(q['end_local']),
        serviceIds: q['service_ids'] === null ? null : (q['service_ids'] as string[]).map(String),
        mode: q['mode'] as RuleMode,
        roomId: q['room_id'] === null ? null : String(q['room_id']),
        overbookable: q['overbookable'] === true,
      });
      byTemplate.set(String(q['template_id']), list);
    }
    return templates.map((t) => ({
      id: String(t['id']),
      clinicianId: String(t['clinician_principal_id']),
      locationId: String(t['location_id']),
      validFrom: dateOnly(t['valid_from']),
      validTo: t['valid_to'] === null ? null : dateOnly(t['valid_to']),
      status: t['status'] as 'active' | 'retired',
      rules: byTemplate.get(String(t['id'])) ?? [],
      version: Number(t['row_version']),
    }));
  }

  private async reread(tx: Tx, clinicianId: string, templateId: string): Promise<TemplateView> {
    const t = await this.getTemplate(tx, clinicianId, templateId);
    if (t === undefined) throw new AvailabilityNotFoundError();
    return t;
  }

  private async insertRules(
    tx: Tx,
    templateId: string,
    clinicianId: string,
    rules: readonly NormalRule[],
    by: string | null,
  ): Promise<void> {
    for (const r of rules)
      await tx.query(
        `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local,
                                               service_ids, mode, room_id, overbookable, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::smallint, $5::time, $6::time, $7::uuid[], $8, $9::uuid, $10, $11::uuid)`,
        [
          uuidv7(),
          templateId,
          clinicianId,
          r.weekday,
          r.start,
          r.end,
          r.serviceIds,
          r.mode,
          r.roomId,
          r.overbookable,
          by,
        ],
      );
  }

  private validateTemplate(i: TemplateInput): NormalTemplate {
    const bad: string[] = [];
    const locationId = isUuid(i?.locationId)
      ? i.locationId.toLowerCase()
      : (bad.push('locationId'), '');
    const validFrom = validDate(i?.validFrom) ?? (bad.push('validFrom'), '');
    let validTo: string | null = null;
    if (i?.validTo !== undefined && i.validTo !== null) {
      validTo = validDate(i.validTo);
      if (validTo === null) bad.push('validTo');
      else if (validFrom !== '' && validTo < validFrom) bad.push('validTo');
    }
    const rules: NormalRule[] = [];
    if (!Array.isArray(i?.rules) || i.rules.length < 1 || i.rules.length > MAX_RULES)
      bad.push('rules');
    else
      i.rules.forEach((r: RuleInput, n) => {
        const at = (f: string): void => void bad.push(`rules/${n}/${f}`);
        const s = minutesOf(r?.startLocal);
        const e = minutesOf(r?.endLocal);
        if (!Number.isInteger(r?.weekday) || r.weekday < 0 || r.weekday > 6) at('weekday');
        if (s === null) at('startLocal');
        if (e === null) at('endLocal');
        if (s !== null && e !== null && s >= e) at('endLocal');
        if (typeof r?.mode !== 'string' || !MODES.includes(r.mode)) at('mode');
        let serviceIds: string[] | null = null;
        if (r?.serviceIds !== undefined && r.serviceIds !== null) {
          if (
            !Array.isArray(r.serviceIds) ||
            r.serviceIds.length < 1 ||
            r.serviceIds.length > 100 ||
            !r.serviceIds.every(isUuid)
          )
            at('serviceIds');
          else serviceIds = [...new Set(r.serviceIds.map((x) => x.toLowerCase()))];
        }
        let roomId: string | null = null;
        if (r?.roomId !== undefined && r.roomId !== null) {
          if (!isUuid(r.roomId)) at('roomId');
          else roomId = r.roomId.toLowerCase();
        }
        if (r?.overbookable !== undefined && typeof r.overbookable !== 'boolean')
          at('overbookable');
        if (bad.length === 0 && s !== null && e !== null)
          rules.push({
            weekday: r.weekday,
            startMin: s,
            endMin: e,
            start: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
            end: `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`,
            serviceIds,
            mode: r.mode,
            roomId,
            overbookable: r.overbookable === true,
          });
      });
    if (bad.length === 0) {
      // Two rules of one template never cover the same time (the same doctor cannot offer one hour twice).
      const sorted = [...rules].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
      for (let k = 1; k < sorted.length; k++) {
        const p = sorted[k - 1] as NormalRule;
        const q = sorted[k] as NormalRule;
        if (p.weekday === q.weekday && q.startMin < p.endMin) bad.push('rules');
      }
    }
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    return { locationId, validFrom, validTo, rules };
  }

  /** The place exists and is active; a google-realm doctor works only at a location they hold; rooms belong to the place. */
  private async checkPlace(
    tx: Tx,
    locationId: string,
    rules: readonly NormalRule[],
  ): Promise<void> {
    const loc = await tx.query(`SELECT active FROM organisation.location WHERE id = $1::uuid`, [
      locationId,
    ]);
    if ((loc.rows[0] as Row | undefined)?.['active'] !== true)
      throw new SchedulingValidationError(['locationId']);
    if (
      tx.scope.realm === 'google' &&
      !(tx.scope.locationIds ?? []).some((l) => l.toLowerCase() === locationId)
    )
      throw new SchedulingScopeError();
    const rooms = [...new Set(rules.flatMap((r) => (r.roomId === null ? [] : [r.roomId])))];
    if (rooms.length > 0) {
      const ok = await tx.query(
        `SELECT count(*)::int AS n FROM organisation.room WHERE id = ANY($1::uuid[]) AND location_id = $2::uuid AND active`,
        [rooms, locationId],
      );
      if (Number((ok.rows[0] as Row)['n']) !== rooms.length)
        throw new SchedulingValidationError(['rules']);
    }
    const services = [...new Set(rules.flatMap((r) => r.serviceIds ?? []))];
    if (services.length > 0) {
      const ok = await tx.query(
        `SELECT count(*)::int AS n FROM organisation.service WHERE id = ANY($1::uuid[])`,
        [services],
      );
      if (Number((ok.rows[0] as Row)['n']) !== services.length)
        throw new SchedulingValidationError(['rules']);
    }
  }

  /** The new template does not offer the same local time as another active template of the doctor at the same place in an overlapping validity. */
  private async checkOverlaps(
    tx: Tx,
    clinicianId: string,
    v: NormalTemplate,
    exceptTemplateId: string | null,
  ): Promise<void> {
    const r = await tx.query(
      `SELECT r.weekday, r.start_local, r.end_local
         FROM scheduling.availability_template t JOIN scheduling.template_rule r ON r.template_id = t.id
        WHERE t.clinician_principal_id = $1::uuid AND t.location_id = $2::uuid AND t.status = 'active'
          AND t.id IS DISTINCT FROM $3::uuid
          AND t.valid_from <= coalesce($5::date, 'infinity'::date) AND coalesce(t.valid_to, 'infinity'::date) >= $4::date`,
      [clinicianId, v.locationId, exceptTemplateId, v.validFrom, v.validTo],
    );
    for (const x of r.rows) {
      const o = x as Row;
      const s = minutesOf(hhmm(o['start_local'])) as number;
      const e = minutesOf(hhmm(o['end_local'])) as number;
      if (v.rules.some((n) => n.weekday === Number(o['weekday']) && n.startMin < e && s < n.endMin))
        throw new SchedulingValidationError(['rules']);
    }
  }

  // ===== blocked time and leave (29.3) ===================================================================================

  async listBlockedTimes(
    tx: Tx,
    clinicianId: string,
    f: { from?: string; to?: string } = {},
  ): Promise<BlockedTimeView[]> {
    const id = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, id);
    const bad: string[] = [];
    const from = f.from === undefined ? this.now().getTime() : instant(f.from);
    const to = f.to === undefined ? null : instant(f.to);
    if (!Number.isFinite(from)) bad.push('from');
    if (to !== null && !Number.isFinite(to)) bad.push('to');
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    const r = await tx.query(
      `SELECT id, clinician_principal_id, lower(period) AS s, upper(period) AS e, kind, note, row_version
         FROM scheduling.blocked_time
        WHERE clinician_principal_id = $1::uuid AND upper(period) > $2::timestamptz AND ($3::timestamptz IS NULL OR lower(period) < $3::timestamptz)
        ORDER BY lower(period), id LIMIT 500`,
      [id, new Date(from).toISOString(), to === null ? null : new Date(to).toISOString()],
    );
    return r.rows.map((x) => blockedView(x as Row));
  }

  /**
   * Active appointments of the doctor that overlap a period: the lapsed holds do not count. Counts only: an occupancy row carries no
   * patient, and the caller may be a doctor who has no right to another patient's appointment (BR-23, 6.5).
   */
  async conflictsFor(
    tx: Tx,
    clinicianId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<ConflictCounts> {
    const r = await tx.query(
      `SELECT status, count(*)::int AS n FROM scheduling.slot_occupancy
        WHERE clinician_principal_id = $1::uuid AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          AND (status IN ('confirmed', 'checked_in', 'in_consultation') OR (status = 'held' AND expires_at > now()))
        GROUP BY status`,
      [clinicianId, startsAt.toISOString(), endsAt.toISOString()],
    );
    const c: ConflictCounts = { total: 0, held: 0, confirmed: 0, checked_in: 0 };
    for (const x of r.rows) {
      const row = x as Row;
      const n = Number(row['n']);
      const key =
        row['status'] === 'held'
          ? 'held'
          : row['status'] === 'confirmed'
            ? 'confirmed'
            : 'checked_in';
      c[key] += n;
      c.total += n;
    }
    return c;
  }

  /**
   * `POST /clinicians/{id}/blocked-times`. With appointments in the period and no `acknowledgeConflicts`, nothing is saved and the answer is
   * `409 scheduling.conflicts_with_appointments` (counts). `dryRun` reports the counts and saves nothing. No appointment is changed.
   */
  async createBlockedTime(
    tx: Tx,
    meta: RequestMeta,
    clinicianId: string,
    input: BlockedTimeInput,
  ): Promise<{ saved: boolean; blockedTime?: BlockedTimeView; conflicts: ConflictCounts }> {
    const cid = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, cid);
    const bad: string[] = [];
    const s = instant(input?.startsAt);
    const e = instant(input?.endsAt);
    if (!Number.isFinite(s)) bad.push('startsAt');
    if (!Number.isFinite(e)) bad.push('endsAt');
    if (Number.isFinite(s) && Number.isFinite(e) && (e <= s || e - s > MAX_BLOCK_DAYS * 86_400_000))
      bad.push('endsAt');
    if (typeof input?.kind !== 'string' || !KINDS.includes(input.kind)) bad.push('kind');
    const note =
      input?.note === undefined || input.note === null
        ? null
        : typeof input.note === 'string' && input.note.length <= 200
          ? input.note.trim() === ''
            ? null
            : input.note
          : (bad.push('note'), null);
    for (const f of ['acknowledgeConflicts', 'dryRun'] as const)
      if (input?.[f] !== undefined && typeof input[f] !== 'boolean') bad.push(f);
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    await this.assertClinicianExists(tx, cid);

    // The same lock the booking transaction takes for the doctor's time (`dr:`, 25.2): an appointment that is being booked at this
    // moment is either counted here or finds the blocked time when its own availability check runs. Only this lock is taken, so
    // there is no order to violate.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('dr:' || $1::text))`, [cid]);
    const conflicts = await this.conflictsFor(tx, cid, new Date(s), new Date(e));
    if (input.dryRun === true) return { saved: false, conflicts };
    if (conflicts.total > 0 && input.acknowledgeConflicts !== true)
      throw new ConflictsWithAppointmentsError({
        total: conflicts.total,
        held: conflicts.held,
        confirmed: conflicts.confirmed,
        checked_in: conflicts.checked_in,
      });
    const id = uuidv7();
    await tx.query(
      `INSERT INTO scheduling.blocked_time (id, organisation_id, clinician_principal_id, period, kind, note, created_by)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5, $6, $7::uuid)`,
      [
        id,
        cid,
        new Date(s).toISOString(),
        new Date(e).toISOString(),
        input.kind,
        note,
        tx.scope.principalId ?? null,
      ],
    );
    await this.audit(tx, meta, 'scheduling.blocked_time', id, null, {
      op: 'create',
      clinicianId: cid,
      kind: input.kind,
      conflicts: conflicts.total,
    });
    const r = await tx.query(
      `SELECT id, clinician_principal_id, lower(period) AS s, upper(period) AS e, kind, note, row_version
         FROM scheduling.blocked_time WHERE id = $1::uuid`,
      [id],
    );
    return { saved: true, blockedTime: blockedView(r.rows[0] as Row), conflicts };
  }

  async deleteBlockedTime(
    tx: Tx,
    meta: RequestMeta,
    clinicianId: string,
    blockedId: string,
  ): Promise<void> {
    const cid = this.requireClinician(clinicianId);
    this.assertClinicianScope(tx, cid);
    if (!isUuid(blockedId)) throw new AvailabilityNotFoundError();
    const r = await tx.query(
      `DELETE FROM scheduling.blocked_time WHERE id = $1::uuid AND clinician_principal_id = $2::uuid RETURNING kind`,
      [blockedId, cid],
    );
    if (r.rows.length === 0) throw new AvailabilityNotFoundError();
    await this.audit(tx, meta, 'scheduling.blocked_time', blockedId, null, {
      op: 'delete',
      clinicianId: cid,
      kind: String((r.rows[0] as Row)['kind']),
    });
  }

  // ===== roster (29.3, 29.4) ==============================================================================================

  async listRoster(
    tx: Tx,
    locationId: string,
    f: { from?: string; to?: string } = {},
  ): Promise<RosterView[]> {
    if (!isUuid(locationId)) throw new AvailabilityNotFoundError();
    this.assertRosterScope(tx, locationId.toLowerCase());
    const bad: string[] = [];
    const from = f.from === undefined ? this.now().getTime() : instant(f.from);
    const to = f.to === undefined ? null : instant(f.to);
    if (!Number.isFinite(from)) bad.push('from');
    if (to !== null && !Number.isFinite(to)) bad.push('to');
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    const r = await tx.query(
      `SELECT id, location_id, duty, principal_id, lower(period) AS s, upper(period) AS e, row_version
         FROM scheduling.roster_entry
        WHERE location_id = $1::uuid AND upper(period) > $2::timestamptz AND ($3::timestamptz IS NULL OR lower(period) < $3::timestamptz)
        ORDER BY lower(period), duty, id LIMIT 500`,
      [
        locationId.toLowerCase(),
        new Date(from).toISOString(),
        to === null ? null : new Date(to).toISOString(),
      ],
    );
    return r.rows.map((x) => rosterView(x as Row));
  }

  /** A front-desk lead edits the roster of their own locations; the admin realm edits every location and every duty. */
  private assertRosterScope(tx: Tx, locationId: string): void {
    const s = tx.scope;
    if (s.audience !== 'staff') throw new SchedulingScopeError();
    if (s.realm === 'admin_pool') return;
    if (s.realm !== 'google' || !(s.locationIds ?? []).some((l) => l.toLowerCase() === locationId))
      throw new SchedulingScopeError();
  }

  async addRoster(
    tx: Tx,
    meta: RequestMeta,
    locationId: string,
    input: RosterInput,
  ): Promise<RosterView> {
    if (!isUuid(locationId)) throw new AvailabilityNotFoundError();
    const loc = locationId.toLowerCase();
    this.assertRosterScope(tx, loc);
    const bad: string[] = [];
    const principalId = isUuid(input?.principalId)
      ? input.principalId.toLowerCase()
      : (bad.push('principalId'), '');
    if (typeof input?.duty !== 'string' || !DUTIES.includes(input.duty)) bad.push('duty');
    const s = instant(input?.startsAt);
    const e = instant(input?.endsAt);
    if (!Number.isFinite(s)) bad.push('startsAt');
    if (!Number.isFinite(e)) bad.push('endsAt');
    if (
      Number.isFinite(s) &&
      Number.isFinite(e) &&
      (e <= s || e - s > ROSTER_MAX_DAYS * 86_400_000)
    )
      bad.push('endsAt');
    if (bad.length > 0) throw new SchedulingValidationError(bad);
    // compliance_on_call is set only through the admin routes (29.4): the staff route refuses it, and so does the policy.
    if (input.duty === 'compliance_on_call' && tx.scope.realm !== 'admin_pool')
      throw new SchedulingScopeError();
    const place = await tx.query(
      `SELECT 1 FROM organisation.location WHERE id = $1::uuid AND active`,
      [loc],
    );
    if (place.rows.length === 0) throw new AvailabilityNotFoundError();
    if (!(await this.holdsDutyRole(tx, principalId, loc, input.duty)))
      throw new RosterPrincipalIneligibleError();
    const id = uuidv7();
    await tx.query('SAVEPOINT roster_add');
    try {
      await tx.query(
        `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4::uuid, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7::uuid)`,
        [
          id,
          loc,
          input.duty,
          principalId,
          new Date(s).toISOString(),
          new Date(e).toISOString(),
          tx.scope.principalId ?? null,
        ],
      );
      await tx.query('RELEASE SAVEPOINT roster_add');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT roster_add');
      // One holder per duty, place and time: an overlapping entry is a validation problem of the period, not a server error.
      if ((err as { code?: unknown } | null)?.code === '23P01')
        throw new SchedulingValidationError(['startsAt']);
      throw err;
    }
    await this.audit(tx, meta, 'scheduling.roster_entry', id, loc, {
      op: 'create',
      duty: input.duty,
      principalId,
    });
    const r = await tx.query(
      `SELECT id, location_id, duty, principal_id, lower(period) AS s, upper(period) AS e, row_version FROM scheduling.roster_entry WHERE id = $1::uuid`,
      [id],
    );
    return rosterView(r.rows[0] as Row);
  }

  async deleteRoster(
    tx: Tx,
    meta: RequestMeta,
    locationId: string,
    entryId: string,
  ): Promise<void> {
    if (!isUuid(locationId) || !isUuid(entryId)) throw new AvailabilityNotFoundError();
    const loc = locationId.toLowerCase();
    this.assertRosterScope(tx, loc);
    const r = await tx.query(
      `DELETE FROM scheduling.roster_entry WHERE id = $1::uuid AND location_id = $2::uuid RETURNING duty`,
      [entryId, loc],
    );
    // A row the caller's policy hides (a compliance duty, for a lead) is simply not found: nothing was deleted.
    if (r.rows.length === 0) throw new AvailabilityNotFoundError();
    await this.audit(tx, meta, 'scheduling.roster_entry', entryId, loc, {
      op: 'delete',
      duty: String((r.rows[0] as Row)['duty']),
    });
  }

  /** Doctor duties need the red-flag alert permission, through a role held at the location (or an organisation-wide one); compliance on call needs that role (22.8). */
  private async holdsDutyRole(
    tx: Tx,
    principalId: string,
    locationId: string,
    duty: RosterDuty,
  ): Promise<boolean> {
    const p = await tx.query(
      `SELECT 1 FROM identity.principal WHERE id = $1::uuid AND status = 'active' AND realm = $2`,
      [principalId, duty === 'compliance_on_call' ? 'admin_pool' : 'google'],
    );
    if (p.rows.length === 0) return false;
    const r =
      duty === 'compliance_on_call'
        ? await tx.query(
            `SELECT 1 FROM identity.role_assignment ra JOIN identity.role ro ON ro.id = ra.role_id
              WHERE ra.principal_id = $1::uuid AND ra.revoked_at IS NULL AND ro.key = 'compliance_on_call' LIMIT 1`,
            [principalId],
          )
        : await tx.query(
            `SELECT 1 FROM identity.role_assignment ra JOIN identity.role_permission rp ON rp.role_id = ra.role_id
              WHERE ra.principal_id = $1::uuid AND ra.revoked_at IS NULL AND rp.permission_key = $3
                AND (ra.location_id = $2::uuid OR ra.location_id IS NULL) LIMIT 1`,
            [principalId, locationId, DOCTOR_DUTY_PERMISSION],
          );
    return r.rows.length > 0;
  }

  // ===== the directory side (22.5.1, 24) =================================================================================

  /**
   * `scheduling.directoryClinicianLocations`: the (clinician, location) pairs with an active template that has not ended, read through the
   * C0 view. The API intersects this with the other two directory sets to answer `GET /clinicians` (22.5.1).
   */
  async directoryClinicianLocations(
    tx: Tx,
    locationId?: string | null,
  ): Promise<{ clinicianId: string; locationId: string }[]> {
    if (locationId !== undefined && locationId !== null && !isUuid(locationId))
      throw new SchedulingValidationError(['locationId']);
    const r = await tx.query(
      `SELECT clinician_principal_id, location_id FROM scheduling.public_clinician_location
        WHERE ($1::uuid IS NULL OR location_id = $1::uuid) ORDER BY location_id, clinician_principal_id`,
      [locationId ?? null],
    );
    return r.rows.map((x) => ({
      clinicianId: String((x as Row)['clinician_principal_id']),
      locationId: String((x as Row)['location_id']),
    }));
  }

  // ===== audit ==========================================================================================================

  /** Configuration changes: ids and counts only. Blocked-time notes and leave reasons never enter the audit trail. */
  private async audit(
    tx: Tx,
    meta: RequestMeta,
    resourceType: string,
    resourceId: string,
    locationId: string | null,
    change: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'config_change',
      resourceType,
      resourceId,
      locationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change,
    });
  }
}

interface NormalRule {
  weekday: number;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  serviceIds: string[] | null;
  mode: RuleMode;
  roomId: string | null;
  overbookable: boolean;
}
interface NormalTemplate {
  locationId: string;
  validFrom: string;
  validTo: string | null;
  rules: NormalRule[];
}

const blockedView = (r: Row): BlockedTimeView => ({
  id: String(r['id']),
  clinicianId: String(r['clinician_principal_id']),
  startsAt: iso(r['s']),
  endsAt: iso(r['e']),
  kind: r['kind'] as BlockedKind,
  note: r['note'] === null ? null : String(r['note']),
  version: Number(r['row_version']),
});

const rosterView = (r: Row): RosterView => ({
  id: String(r['id']),
  locationId: String(r['location_id']),
  duty: r['duty'] as RosterDuty,
  principalId: String(r['principal_id']),
  startsAt: iso(r['s']),
  endsAt: iso(r['e']),
  version: Number(r['row_version']),
});
