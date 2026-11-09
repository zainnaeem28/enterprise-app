// The admin configuration routes of ARCHITECTURE 29.4 for the organisation module (BE-23). Authorization (realm `admin_pool`,
// permission, live elevation grant) is the guard's and is declared on the controller; every method here runs in ONE transaction
// under the caller's own scope, so the table policies are the second line. Each accepted change writes its audit row (action
// `config_change`, who from the scope, `change: {before, after}`) in the same transaction: a failed audit write rolls the change
// back. A refusal that must be audited is written with `recordDenied` after the business transaction has ended.
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { AuditService } from '../../audit/index.js';
import {
  NeutralNameRequiredError,
  OrganisationValidationError,
  SettingNotConfiguredError,
} from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { OrganisationService } from '../service.js';
import { SETTING_CATALOGUE } from '../settings-catalogue.js';
import { assertMatchesSchema } from '../settings.js';
import { FLAG_RULES } from './flag-rules.js';
import {
  asObject,
  cursorFor,
  etag,
  ifMatchVersion,
  invalid,
  invalidField,
  isUuid,
  notFound,
  onlyKeys,
  parseFields,
  parsePage,
  parseValue,
} from './fields.js';
import type { FieldDef } from './fields.js';

type Row = Record<string, unknown>;

export interface Meta {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface Page {
  items: Row[];
  nextCursor: string | null;
}
/** A single row and the ETag the route sends. */
export interface One {
  body: Row;
  etag: string | null;
}

export interface AdminDeps {
  db: KernelDb;
  audit: Pick<AuditService, 'record' | 'recordDenied'>;
  organisation: Pick<OrganisationService, 'setSetting' | 'setting'>;
}

interface Def {
  /** Audit resource type. */
  type: string;
  table: string;
  fields: FieldDef[];
  order: string;
  /** Query filters (field names). */
  filters: string[];
  /** `self` (the row is a location) or the name of the field that holds the location id. */
  loc?: string;
  /** A row may be removed with `{id, remove: true}`. */
  removable?: boolean;
  /** Fills defaults on create (mutates `vals`). */
  defaults?: (tx: Tx, vals: Row) => Promise<void>;
  /** Checks the merged state of a create or patch. */
  check?: (merged: Row) => void;
}

const camel = (s: string): string => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Foreign-key columns of the organisation tables, named in the constraint (`room_location_id_fkey`). */
const FK_COLUMNS = ['location_id', 'service_id', 'jurisdiction_code', 'state_code'] as const;

/** The request path a database constraint failure belongs to, from the column or constraint name only (never a value). */
function pgPath(e: unknown): string {
  const o = e as { column?: unknown; constraint?: unknown };
  if (typeof o.column === 'string' && /^[a-z_]+$/.test(o.column) && o.column !== 'organisation_id')
    return `/${camel(o.column)}`;
  if (typeof o.constraint === 'string' && o.constraint.endsWith('_fkey')) {
    const col = FK_COLUMNS.find((c) => (o.constraint as string).includes(c));
    if (col !== undefined) return `/${camel(col)}`;
  }
  return '/';
}

/** Domain and database failures -> the standard API errors of ARCHITECTURE 28.4 / 30. Codes only; nothing from a value or a driver message. */
export function translate(e: unknown): unknown {
  if (e instanceof ApiError) return e;
  if (e instanceof NeutralNameRequiredError) return new ApiError(422, e.code);
  if (e instanceof OrganisationValidationError)
    return invalid(e.fields.map((f) => ({ path: `/${f}`, code: 'kernel.invalid_format' })));
  if (e instanceof SettingNotConfiguredError) return new ApiError(503, 'kernel.unavailable', true);
  const code = (e as { code?: unknown } | null)?.code;
  switch (code) {
    case '23505':
      return invalid([{ path: pgPath(e), code: 'kernel.duplicate' }]);
    case '23503':
      return invalid([{ path: pgPath(e), code: 'kernel.unknown_reference' }]);
    case '23502':
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return invalid([{ path: pgPath(e), code: 'kernel.invalid_format' }]);
    default:
      return e;
  }
}

const f = (n: string, c: string, k: FieldDef['k'], o: Partial<FieldDef> = {}): FieldDef => ({
  n,
  c,
  k,
  ...o,
});

const LOCATIONS: Def = {
  type: 'organisation.location',
  table: 'organisation.location',
  order: 'name, id',
  filters: ['active'],
  loc: 'self',
  fields: [
    f('name', 'name', 'text', { req: true }),
    f('kind', 'kind', 'enum', { req: true, values: ['clinic', 'virtual'] }),
    f('timeZone', 'time_zone', 'tz', { req: true }),
    f('address', 'address', 'json', { nullable: true }),
    f('stateCode', 'state_code', 'state', { req: true }),
    f('phone', 'phone', 'text', { nullable: true, max: 40 }),
    f('active', 'active', 'bool'),
  ],
};
const ROOMS: Def = {
  type: 'organisation.room',
  table: 'organisation.room',
  order: 'location_id, name, id',
  filters: ['locationId', 'active'],
  loc: 'locationId',
  fields: [
    f('locationId', 'location_id', 'uuid', { req: true, fixed: true }),
    f('name', 'name', 'text', { req: true, max: 100 }),
    f('active', 'active', 'bool'),
  ],
};
const HOLIDAYS: Def = {
  type: 'organisation.holiday',
  table: 'organisation.holiday',
  order: 'date, location_id NULLS FIRST, id',
  filters: ['locationId'],
  loc: 'locationId',
  removable: true,
  fields: [
    f('locationId', 'location_id', 'uuid', { nullable: true, fixed: true }),
    f('date', 'date', 'date', { req: true }),
    f('name', 'name', 'text', { req: true }),
  ],
};
const MONEY = { min: 0, max: 1_000_000_000_000, big: true } as const;
const SERVICES: Def = {
  type: 'organisation.service',
  table: 'organisation.service',
  order: 'internal_name, id',
  filters: ['active'],
  fields: [
    f('internalName', 'internal_name', 'text', { req: true }),
    f('patientDisplayName', 'patient_display_name', 'text'),
    f('durationMin', 'duration_min', 'int', { req: true, min: 5, max: 480 }),
    f('bufferMin', 'buffer_min', 'int', { min: 0, max: 120 }),
    f('mode', 'mode', 'enum', { req: true, values: ['in_person', 'video', 'either'] }),
    // Stored only: nothing in R1 charges anything (D-3).
    f('priceCents', 'price_cents', 'int', { ...MONEY, nullable: true }),
    f('currency', 'currency', 'currency', { nullable: true }),
    f('feeCents', 'fee_cents', 'int', { ...MONEY, nullable: true }),
    f('conditionRevealing', 'condition_revealing', 'bool'),
    f('active', 'active', 'bool'),
  ],
  defaults: (_tx, v) => {
    v['bufferMin'] ??= 0;
    if (v['patientDisplayName'] === undefined && v['conditionRevealing'] !== true)
      v['patientDisplayName'] = v['internalName'];
    return Promise.resolve();
  },
  // BR-23 extension: a condition-revealing service shows patients a name other than its internal one.
  check: (m) => {
    const display = String(m['patientDisplayName'] ?? '')
      .trim()
      .toLowerCase();
    const internal = String(m['internalName'] ?? '')
      .trim()
      .toLowerCase();
    if (m['conditionRevealing'] === true && (display === '' || display === internal))
      throw new NeutralNameRequiredError();
  },
};
const BANNERS: Def = {
  type: 'organisation.banner',
  table: 'organisation.banner',
  order: 'starts_at DESC, id',
  filters: ['surface'],
  removable: true,
  fields: [
    f('surface', 'surface', 'enum', { req: true, values: ['site', 'patient', 'staff', 'partner'] }),
    f('message', 'message', 'text', { req: true, max: 500 }),
    f('startsAt', 'starts_at', 'ts', { req: true }),
    f('endsAt', 'ends_at', 'ts', { req: true }),
  ],
  check: (m) => {
    if (Date.parse(String(m['startsAt'])) >= Date.parse(String(m['endsAt'])))
      throw invalid([{ path: '/endsAt', code: 'kernel.invalid_range' }]);
    // A banner is public text on every host and holds no PHI (TC-AD-09): refuse what looks like an e-mail address or a
    // long identifier. This is a guard against slips, not a PHI detector; the administrator writes the text.
    const msg = String(m['message']);
    if (/@|\d{9,}/.test(msg)) throw invalid([{ path: '/message', code: 'kernel.invalid_format' }]);
  },
};

const sel = (c: FieldDef): string => {
  switch (c.k) {
    case 'date':
      return `to_char(${c.c}, 'YYYY-MM-DD')`;
    case 'time':
      return `to_char(${c.c}, 'HH24:MI')`;
    case 'ts':
      return `to_char(${c.c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    default:
      return c.big === true ? `${c.c}::float8` : c.c;
  }
};
const selectList = (fields: readonly FieldDef[]): string =>
  fields.map((c) => `${sel(c)} AS "${c.n}"`).join(', ');
const norm = (r: Row): Row => ({ ...r, rowVersion: Number(r['rowVersion']) });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const pick = (r: Row, names: readonly string[]): Row =>
  Object.fromEntries(names.map((n) => [n, r[n] ?? null]));
const lockKey = (tx: Tx, k: string): Promise<unknown> =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [k]);

const FLAG_KEY = /^[a-z][a-z0-9_]{0,99}$/;
const KEY100 = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_SCHEMA_BYTES = 256 * 1024;

export class OrganisationAdminService {
  constructor(private readonly d: AdminDeps) {}

  // --- plumbing -----------------------------------------------------------------------------------------------------

  private async write<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.d.db.withScope(scope, fn);
    } catch (e) {
      throw translate(e);
    }
  }

  private async read<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.d.db.withScope(
        scope,
        async (tx) => {
          await tx.query('SET LOCAL transaction_read_only = on');
          return fn(tx);
        },
        { idempotent: true },
      );
    } catch (e) {
      throw translate(e);
    }
  }

  private async changed(
    tx: Tx,
    meta: Meta,
    type: string,
    resourceId: string | null,
    locationId: string | null,
    change: Record<string, unknown>,
  ): Promise<void> {
    await this.d.audit.record(tx, {
      requestId: meta.requestId,
      action: 'config_change',
      resourceType: type,
      resourceId,
      locationId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      change,
    });
  }

  private locOf(def: Def, row: Row): string | null {
    if (def.loc === undefined) return null;
    const v = def.loc === 'self' ? row['id'] : row[def.loc];
    return typeof v === 'string' ? v : null;
  }

  private async page(
    tx: Tx,
    sql: string,
    params: unknown[],
    q: Record<string, unknown>,
  ): Promise<Page> {
    const { limit, offset } = parsePage(q);
    const r = await tx.query(`${sql} LIMIT ${limit + 1} OFFSET ${offset}`, params);
    const rows = (r.rows as Row[]).map(norm);
    const more = rows.length > limit;
    return { items: rows.slice(0, limit), nextCursor: more ? cursorFor(offset + limit) : null };
  }

  /** Equality filters from the query string, validated like the fields they name. */
  private filtersOf(def: Def, q: Record<string, unknown>): { where: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const name of def.filters) {
      const raw = q[name];
      if (raw === undefined) continue;
      const fd = def.fields.find((x) => x.n === name);
      if (fd === undefined) continue;
      const v = parseValue(fd, fd.k === 'bool' ? { true: true, false: false }[String(raw)] : raw);
      if (v === undefined) throw invalidField(name);
      params.push(v);
      parts.push(`${fd.c} = $${params.length}`);
    }
    return { where: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', params };
  }

  // --- the generic id-keyed resources --------------------------------------------------------------------------------

  private listOf(scope: ScopeSettings, def: Def, q: Record<string, unknown>): Promise<Page> {
    const { where, params } = this.filtersOf(def, q);
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT id, row_version::text AS "rowVersion", ${selectList(def.fields)} FROM ${def.table}${where} ORDER BY ${def.order}`,
        params,
        q,
      ),
    );
  }

  private async rowOf(tx: Tx, def: Def, id: string, lock = false): Promise<Row | undefined> {
    const r = await tx.query(
      `SELECT id, row_version::text AS "rowVersion", ${selectList(def.fields)} FROM ${def.table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    const row = r.rows[0] as Row | undefined;
    return row === undefined ? undefined : norm(row);
  }

  private async createOf(scope: ScopeSettings, def: Def, body: unknown, meta: Meta): Promise<One> {
    const vals = parseFields(def.fields, asObject(body), 'create');
    return this.write(scope, async (tx) => {
      await def.defaults?.(tx, vals);
      def.check?.(vals);
      const id = uuidv7();
      const used = def.fields.filter((x) => vals[x.n] !== undefined);
      const cols = ['id', 'organisation_id', 'created_by', ...used.map((x) => x.c)];
      const params: unknown[] = [
        id,
        tx.scope.orgId,
        tx.scope.principalId ?? null,
        ...used.map((x) =>
          x.k === 'json' && vals[x.n] !== null ? JSON.stringify(vals[x.n]) : vals[x.n],
        ),
      ];
      const marks = cols.map((_c, i) => {
        const x = used[i - 3];
        return `$${i + 1}${x?.k === 'json' ? '::jsonb' : ''}`;
      });
      await tx.query(
        `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${marks.join(', ')})`,
        params,
      );
      const row = (await this.rowOf(tx, def, id)) as Row;
      await this.changed(tx, meta, def.type, id, this.locOf(def, row), {
        before: null,
        after: pick(
          row,
          def.fields.map((x) => x.n),
        ),
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  /** PATCH `{id, ...changes}` (If-Match, or `ifMatch` undefined for PUT-style upserts) and removal `{id, remove: true}`. */
  private async patchOf(
    scope: ScopeSettings,
    def: Def,
    body: unknown,
    ifMatch: number | undefined,
    meta: Meta,
  ): Promise<One> {
    const o = asObject(body);
    if (!isUuid(o['id']))
      throw invalidField('id', o['id'] === undefined ? 'kernel.required' : 'kernel.invalid_format');
    const id = o['id'];
    const remove = o['remove'];
    if (remove !== undefined && (remove !== true || def.removable !== true))
      throw invalidField('remove');
    if (remove === true) {
      const extra = onlyKeys(o, ['id', 'remove']);
      if (extra.length > 0) throw invalid(extra);
    }
    const vals = remove === true ? {} : parseFields(def.fields, o, 'patch', ['id']);
    if (remove !== true && Object.keys(vals).length === 0)
      throw invalid([{ path: '/', code: 'kernel.required' }]);
    return this.write(scope, async (tx) => {
      const before = await this.rowOf(tx, def, id, true);
      if (before === undefined) throw notFound();
      if (ifMatch !== undefined && Number(before['rowVersion']) !== ifMatch)
        throw new ApiError(412, 'kernel.precondition_failed');
      const names = def.fields.map((x) => x.n);
      if (remove === true) {
        await tx.query(`DELETE FROM ${def.table} WHERE id = $1`, [id]);
        await this.changed(tx, meta, def.type, id, this.locOf(def, before), {
          before: pick(before, names),
          after: null,
        });
        return { body: { id, removed: true }, etag: null };
      }
      const merged = { ...before, ...vals };
      def.check?.(merged);
      const keys = Object.keys(vals).filter((k) => !same(vals[k], before[k]));
      if (keys.length === 0) return { body: before, etag: etag(before['rowVersion'] as number) };
      const set = keys.map((k, i) => {
        const fd = def.fields.find((x) => x.n === k) as FieldDef;
        return `${fd.c} = $${i + 2}${fd.k === 'json' ? '::jsonb' : ''}`;
      });
      const params = keys.map((k) => {
        const fd = def.fields.find((x) => x.n === k) as FieldDef;
        return fd.k === 'json' && vals[k] !== null ? JSON.stringify(vals[k]) : vals[k];
      });
      await tx.query(`UPDATE ${def.table} SET ${set.join(', ')} WHERE id = $1`, [id, ...params]);
      const row = (await this.rowOf(tx, def, id)) as Row;
      await this.changed(tx, meta, def.type, id, this.locOf(def, row), {
        before: pick(before, keys),
        after: pick(row, keys),
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  // --- locations, rooms, holidays, services, policies, banners ------------------------------------------------------------

  listLocations = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, LOCATIONS, q);
  createLocation = (s: ScopeSettings, b: unknown, m: Meta): Promise<One> =>
    this.createOf(s, LOCATIONS, b, m);
  patchLocation = (
    s: ScopeSettings,
    b: unknown,
    ifMatch: string | undefined,
    m: Meta,
  ): Promise<One> => this.patchOf(s, LOCATIONS, b, ifMatchVersion(ifMatch), m);

  listRooms = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, ROOMS, q);
  createRoom = (s: ScopeSettings, b: unknown, m: Meta): Promise<One> =>
    this.createOf(s, ROOMS, b, m);
  patchRoom = (s: ScopeSettings, b: unknown, ifMatch: string | undefined, m: Meta): Promise<One> =>
    this.patchOf(s, ROOMS, b, ifMatchVersion(ifMatch), m);

  listHolidays = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, HOLIDAYS, q);
  createHoliday = (s: ScopeSettings, b: unknown, m: Meta): Promise<One> =>
    this.createOf(s, HOLIDAYS, b, m);
  patchHoliday = (
    s: ScopeSettings,
    b: unknown,
    ifMatch: string | undefined,
    m: Meta,
  ): Promise<One> => this.patchOf(s, HOLIDAYS, b, ifMatchVersion(ifMatch), m);

  listServices = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, SERVICES, q);
  createService = (s: ScopeSettings, b: unknown, m: Meta): Promise<One> =>
    this.createOf(s, SERVICES, b, m);
  patchService = (
    s: ScopeSettings,
    b: unknown,
    ifMatch: string | undefined,
    m: Meta,
  ): Promise<One> => this.patchOf(s, SERVICES, b, ifMatchVersion(ifMatch), m);

  /** Policy defaults come from the settings (31.4); nothing falls back to a value written in code. */
  private get policies(): Def {
    return {
      type: 'organisation.booking_policy',
      table: 'organisation.booking_policy',
      order: 'service_id, location_id NULLS FIRST, id',
      filters: ['serviceId', 'locationId'],
      loc: 'locationId',
      fields: [
        f('serviceId', 'service_id', 'uuid', { req: true, fixed: true }),
        f('locationId', 'location_id', 'uuid', { nullable: true, fixed: true }),
        f('leadTimeMin', 'lead_time_min', 'int', { min: 0, max: 525_600 }),
        f('cutoffHours', 'cutoff_hours', 'int', { min: 0, max: 8760 }),
        // `fee` is accepted and stored; nothing charges it (D-3).
        f('lateChange', 'late_change', 'enum', { values: ['block', 'fee'] }),
        f('maxFuturePerPatient', 'max_future_per_patient', 'int', { min: 1, max: 1000 }),
        f('waitlistEnabled', 'waitlist_enabled', 'bool'),
        f('overbookCapPerSession', 'overbook_cap_per_session', 'int', { min: 0, max: 1000 }),
        f('holdMinutes', 'hold_minutes', 'int', { min: 1, max: 120, nullable: true }),
        f('noShowGraceMin', 'no_show_grace_min', 'int', { min: 0, max: 240, nullable: true }),
      ],
      defaults: async (tx, v) => {
        const loc = (v['locationId'] as string | null | undefined) ?? null;
        v['cutoffHours'] ??= await this.d.organisation.setting<number>(tx, 'cutoff_hours', loc);
        v['maxFuturePerPatient'] ??= await this.d.organisation.setting<number>(
          tx,
          'max_future_per_patient',
          loc,
        );
      },
    };
  }
  listPolicies = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, this.policies, q);
  createPolicy = (s: ScopeSettings, b: unknown, m: Meta): Promise<One> =>
    this.createOf(s, this.policies, b, m);
  patchPolicy = (
    s: ScopeSettings,
    b: unknown,
    ifMatch: string | undefined,
    m: Meta,
  ): Promise<One> => this.patchOf(s, this.policies, b, ifMatchVersion(ifMatch), m);

  listBanners = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.listOf(s, BANNERS, q);
  /** PUT /admin/banners: `{surface, message, startsAt, endsAt}` posts one; `{id, ...}` changes one; `{id, remove: true}` takes it down. */
  putBanner(s: ScopeSettings, b: unknown, m: Meta): Promise<One> {
    const o = asObject(b);
    return o['id'] === undefined
      ? this.createOf(s, BANNERS, b, m)
      : this.patchOf(s, BANNERS, b, undefined, m);
  }

  // --- opening hours (keyed by location, weekday and opening time) ------------------------------------------------------

  private static readonly HOURS: FieldDef[] = [
    f('locationId', 'location_id', 'uuid', { req: true, fixed: true }),
    f('weekday', 'weekday', 'int', { req: true, fixed: true, min: 0, max: 6 }),
    f('opens', 'opens', 'time', { req: true, fixed: true }),
    f('closes', 'closes', 'time', { req: true }),
  ];
  private static readonly HOURS_SELECT = `location_id AS "locationId", weekday, to_char(opens, 'HH24:MI') AS opens, to_char(closes, 'HH24:MI') AS closes, row_version::text AS "rowVersion"`;

  listOpeningHours(scope: ScopeSettings, q: Record<string, unknown>): Promise<Page> {
    const params: unknown[] = [];
    let where = '';
    if (q['locationId'] !== undefined) {
      if (!isUuid(q['locationId'])) throw invalidField('locationId');
      params.push(q['locationId']);
      where = ' WHERE location_id = $1';
    }
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT ${OrganisationAdminService.HOURS_SELECT} FROM organisation.opening_hours${where} ORDER BY location_id, weekday, opens`,
        params,
        q,
      ),
    );
  }

  private async hoursOverlap(
    tx: Tx,
    loc: string,
    weekday: number,
    opens: string,
    closes: string,
    exceptOpens?: string,
  ): Promise<void> {
    const r = await tx.query(
      `SELECT 1 FROM organisation.opening_hours
        WHERE location_id = $1 AND weekday = $2 AND opens < $4::time AND closes > $3::time
          AND ($5::time IS NULL OR opens <> $5::time) LIMIT 1`,
      [loc, weekday, opens, closes, exceptOpens ?? null],
    );
    if (r.rows.length > 0) throw invalid([{ path: '/opens', code: 'kernel.overlap' }]);
  }

  async createOpeningHours(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const v = parseFields(OrganisationAdminService.HOURS, asObject(body), 'create');
    const [loc, weekday, opens, closes] = [
      v['locationId'],
      v['weekday'],
      v['opens'],
      v['closes'],
    ] as [string, number, string, string];
    if (opens >= closes) throw invalid([{ path: '/closes', code: 'kernel.invalid_range' }]);
    return this.write(scope, async (tx) => {
      // The location row is the lock that serialises concurrent edits of one location's hours.
      const l = await tx.query(`SELECT 1 FROM organisation.location WHERE id = $1 FOR UPDATE`, [
        loc,
      ]);
      if (l.rows.length === 0)
        throw invalid([{ path: '/locationId', code: 'kernel.unknown_reference' }]);
      await this.hoursOverlap(tx, loc, weekday, opens, closes);
      await tx.query(
        `INSERT INTO organisation.opening_hours (organisation_id, location_id, weekday, opens, closes, created_by)
         VALUES ($1, $2, $3, $4::time, $5::time, $6)`,
        [tx.scope.orgId, loc, weekday, opens, closes, tx.scope.principalId ?? null],
      );
      const row = await this.hoursRow(tx, loc, weekday, opens);
      await this.changed(tx, meta, 'organisation.opening_hours', null, loc, {
        weekday,
        opens,
        before: null,
        after: { closes },
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  private async hoursRow(
    tx: Tx,
    loc: string,
    weekday: number,
    opens: string,
    lock = false,
  ): Promise<Row> {
    const r = await tx.query(
      `SELECT ${OrganisationAdminService.HOURS_SELECT} FROM organisation.opening_hours
        WHERE location_id = $1 AND weekday = $2 AND opens = $3::time${lock ? ' FOR UPDATE' : ''}`,
      [loc, weekday, opens],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) throw notFound();
    return norm(row);
  }

  /** PATCH `{locationId, weekday, opens, closes}` moves the closing time; `{locationId, weekday, opens, remove: true}` deletes the interval. */
  async patchOpeningHours(
    scope: ScopeSettings,
    body: unknown,
    ifMatch: string | undefined,
    meta: Meta,
  ): Promise<One> {
    const o = asObject(body);
    const remove = o['remove'];
    if (remove !== undefined && remove !== true) throw invalidField('remove');
    return this.patchHours(scope, o, remove === true, ifMatchVersion(ifMatch), meta);
  }

  private async patchHours(
    scope: ScopeSettings,
    o: Record<string, unknown>,
    remove: boolean,
    expected: number,
    meta: Meta,
  ): Promise<One> {
    const keyFields = OrganisationAdminService.HOURS.filter((x) => x.n !== 'closes');
    const k = parseFields(keyFields, o, 'create', ['closes', 'remove']);
    const closes = remove
      ? undefined
      : parseValue(OrganisationAdminService.HOURS[3] as FieldDef, o['closes']);
    if (!remove && closes === undefined)
      throw invalidField(
        'closes',
        o['closes'] === undefined ? 'kernel.required' : 'kernel.invalid_format',
      );
    const [loc, weekday, opens] = [k['locationId'], k['weekday'], k['opens']] as [
      string,
      number,
      string,
    ];
    return this.write(scope, async (tx) => {
      const l = await tx.query(`SELECT 1 FROM organisation.location WHERE id = $1 FOR UPDATE`, [
        loc,
      ]);
      if (l.rows.length === 0) throw notFound();
      const before = await this.hoursRow(tx, loc, weekday, opens, true);
      if (Number(before['rowVersion']) !== expected)
        throw new ApiError(412, 'kernel.precondition_failed');
      if (remove) {
        await tx.query(
          `DELETE FROM organisation.opening_hours WHERE location_id = $1 AND weekday = $2 AND opens = $3::time`,
          [loc, weekday, opens],
        );
        await this.changed(tx, meta, 'organisation.opening_hours', null, loc, {
          weekday,
          opens,
          before: { closes: before['closes'] },
          after: null,
        });
        return { body: { locationId: loc, weekday, opens, removed: true }, etag: null };
      }
      if (opens >= (closes as string))
        throw invalid([{ path: '/closes', code: 'kernel.invalid_range' }]);
      if (before['closes'] === closes) return { body: before, etag: etag(expected) };
      await this.hoursOverlap(tx, loc, weekday, opens, closes as string, opens);
      await tx.query(
        `UPDATE organisation.opening_hours SET closes = $4::time WHERE location_id = $1 AND weekday = $2 AND opens = $3::time`,
        [loc, weekday, opens, closes],
      );
      const row = await this.hoursRow(tx, loc, weekday, opens);
      await this.changed(tx, meta, 'organisation.opening_hours', null, loc, {
        weekday,
        opens,
        before: { closes: before['closes'] },
        after: { closes },
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  // --- feature flags (per location, 29.4; RA-R1-26) -----------------------------------------------------------------------

  listFeatureFlags(scope: ScopeSettings, q: Record<string, unknown>): Promise<Page> {
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT id, key, location_id AS "locationId", enabled, row_version::text AS "rowVersion"
           FROM organisation.feature_flag ORDER BY key, location_id NULLS FIRST`,
        [],
        q,
      ),
    );
  }

  /**
   * PUT `{key, locationId?, enabled}` sets a flag for the organisation or for one location; `{key, locationId?, remove: true}`
   * deletes the row. A write the flag's rule refuses (`patient_messaging` on, INT03-F17) changes nothing, is audited as a denial
   * with who, the current value and the attempted one, and is answered `400 kernel.validation_failed`.
   */
  async putFeatureFlag(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const o = asObject(body);
    const errors = onlyKeys(o, ['key', 'locationId', 'enabled', 'remove']);
    const key = o['key'];
    if (typeof key !== 'string' || !FLAG_KEY.test(key))
      errors.push({
        path: '/key',
        code: key === undefined ? 'kernel.required' : 'kernel.invalid_format',
      });
    const loc = o['locationId'] ?? null;
    if (loc !== null && !isUuid(loc))
      errors.push({ path: '/locationId', code: 'kernel.invalid_format' });
    const remove = o['remove'] === true;
    if (o['remove'] !== undefined && o['remove'] !== true)
      errors.push({ path: '/remove', code: 'kernel.invalid_format' });
    const enabled = o['enabled'];
    if (remove ? enabled !== undefined : typeof enabled !== 'boolean')
      errors.push({
        path: '/enabled',
        code: enabled === undefined ? 'kernel.required' : 'kernel.invalid_format',
      });
    if (errors.length > 0) throw invalid(errors);
    const k = key as string;
    const l = loc as string | null;

    const out = await this.write(scope, async (tx) => {
      await lockKey(tx, `flag:${k}:${l ?? ''}`);
      if (l !== null) {
        const e = await tx.query(`SELECT 1 FROM organisation.location WHERE id = $1`, [l]);
        if (e.rows.length === 0)
          throw invalid([{ path: '/locationId', code: 'kernel.unknown_reference' }]);
      }
      const cur = await tx.query(
        `SELECT id, enabled FROM organisation.feature_flag WHERE key = $1 AND location_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,
        [k, l],
      );
      const before = cur.rows[0] as { id: string; enabled: boolean } | undefined;
      const rule = FLAG_RULES[k];
      if (!remove && enabled === true && rule !== undefined && !rule.enabledAllowed)
        return { refused: rule.rule, before: before ?? null } as const;
      if (remove) {
        if (before === undefined) throw notFound();
        await tx.query(`DELETE FROM organisation.feature_flag WHERE id = $1`, [before.id]);
        await this.changed(tx, meta, 'organisation.feature_flag', before.id, l, {
          key: k,
          before: { enabled: before.enabled },
          after: null,
        });
        return {
          one: { body: { id: before.id, key: k, locationId: l, removed: true }, etag: null },
        };
      }
      const r = await tx.query(
        `INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT feature_flag_key_location_uq DO UPDATE SET enabled = EXCLUDED.enabled
         RETURNING id, key, location_id AS "locationId", enabled, row_version::text AS "rowVersion"`,
        [uuidv7(), tx.scope.orgId, k, l, enabled, tx.scope.principalId ?? null],
      );
      const row = norm(r.rows[0] as Row);
      if (before === undefined || before.enabled !== enabled)
        await this.changed(tx, meta, 'organisation.feature_flag', row['id'] as string, l, {
          key: k,
          before: before === undefined ? null : { enabled: before.enabled },
          after: { enabled },
        });
      return { one: { body: row, etag: etag(row['rowVersion'] as number) } };
    });
    if ('refused' in out) {
      const prev = out.before ?? null;
      await this.d.audit.recordDenied(this.d.db, scope, {
        requestId: meta.requestId,
        resourceType: 'organisation.feature_flag',
        resourceId: prev === null ? null : prev.id,
        locationId: l,
        denialReason: 'forbidden',
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: {
          key: k,
          rule: out.refused,
          before: prev === null ? null : { enabled: prev.enabled },
          attempted: { enabled: true },
        },
      });
      throw invalid([{ path: '/enabled', code: 'kernel.invalid_value' }]);
    }
    return out.one;
  }

  // --- settings (31.4) -------------------------------------------------------------------------------------------------------

  listSettings(scope: ScopeSettings, q: Record<string, unknown>): Promise<Page> {
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT id, key, value, value_schema AS "valueSchema", location_id AS "locationId", pre_auth AS "preAuth",
                row_version::text AS "rowVersion"
           FROM kernel.setting ORDER BY key, location_id NULLS FIRST`,
        [],
        q,
      ),
    );
  }

  /** PUT `{key, value, locationId?}`: a catalogued key, a value that matches its schema. Keys readable before sign-in are reference data and are refused. */
  async putSetting(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const o = asObject(body);
    const errors = onlyKeys(o, ['key', 'value', 'locationId']);
    const entry =
      typeof o['key'] === 'string' ? SETTING_CATALOGUE.find((x) => x.key === o['key']) : undefined;
    if (entry === undefined)
      errors.push({
        path: '/key',
        code: o['key'] === undefined ? 'kernel.required' : 'kernel.invalid_format',
      });
    const loc = o['locationId'] ?? null;
    if (loc !== null && !isUuid(loc))
      errors.push({ path: '/locationId', code: 'kernel.invalid_format' });
    if (o['value'] === undefined) errors.push({ path: '/value', code: 'kernel.required' });
    else if (entry !== undefined && !errors.some((e) => e.path === '/key')) {
      try {
        assertMatchesSchema(entry.schema, o['value']);
      } catch {
        errors.push({ path: '/value', code: 'kernel.invalid_format' });
      }
    }
    if (errors.length > 0 || entry === undefined) throw invalid(errors);
    const l = loc as string | null;
    if (entry.preAuth) {
      await this.d.audit.recordDenied(this.d.db, scope, {
        requestId: meta.requestId,
        resourceType: 'kernel.setting',
        locationId: l,
        denialReason: 'forbidden',
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: { key: entry.key, rule: 'pre_auth_reference_data' },
      });
      throw new ApiError(403, 'auth.forbidden');
    }
    return this.write(scope, async (tx) => {
      await lockKey(tx, `setting:${entry.key}:${l ?? ''}`);
      if (l !== null) {
        const e = await tx.query(`SELECT 1 FROM organisation.location WHERE id = $1`, [l]);
        if (e.rows.length === 0)
          throw invalid([{ path: '/locationId', code: 'kernel.unknown_reference' }]);
      }
      const cur = await tx.query(
        `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NOT DISTINCT FROM $2::uuid`,
        [entry.key, l],
      );
      const had = cur.rows.length > 0;
      const prev = (cur.rows[0] as { value?: unknown } | undefined)?.value ?? null;
      await this.d.organisation.setSetting(tx, entry.key, o['value'], l);
      const r = await tx.query(
        `SELECT id, key, value, value_schema AS "valueSchema", location_id AS "locationId", pre_auth AS "preAuth",
                row_version::text AS "rowVersion"
           FROM kernel.setting WHERE key = $1 AND location_id IS NOT DISTINCT FROM $2::uuid`,
        [entry.key, l],
      );
      const row = norm(r.rows[0] as Row);
      if (!had || !same(prev, o['value']))
        await this.changed(tx, meta, 'kernel.setting', row['id'] as string, l, {
          key: entry.key,
          before: had ? { value: prev } : null,
          after: { value: o['value'] },
        });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  // --- operating states (BD-17) -----------------------------------------------------------------------------------------------

  listOperatingStates(scope: ScopeSettings, q: Record<string, unknown>): Promise<Page> {
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT jurisdiction_code AS "jurisdictionCode", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                telehealth_allowed AS "telehealthAllowed", row_version::text AS "rowVersion"
           FROM organisation.operating_state ORDER BY jurisdiction_code, effective_from DESC`,
        [],
        q,
      ),
    );
  }

  /** PUT `{jurisdictionCode, effectiveFrom, telehealthAllowed}`: upserts the state in effect from that date. */
  async putOperatingState(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const v = parseFields(
      [
        f('jurisdictionCode', 'jurisdiction_code', 'state', { req: true }),
        f('effectiveFrom', 'effective_from', 'date', { req: true }),
        f('telehealthAllowed', 'telehealth_allowed', 'bool', { req: true }),
      ],
      asObject(body),
      'create',
    );
    const [code, from, allowed] = [
      v['jurisdictionCode'],
      v['effectiveFrom'],
      v['telehealthAllowed'],
    ] as [string, string, boolean];
    return this.write(scope, async (tx) => {
      await lockKey(tx, `operating_state:${code}:${from}`);
      const cur = await tx.query(
        `SELECT telehealth_allowed AS allowed FROM organisation.operating_state WHERE jurisdiction_code = $1 AND effective_from = $2::date FOR UPDATE`,
        [code, from],
      );
      const before = (cur.rows[0] as { allowed: boolean } | undefined)?.allowed;
      const r = await tx.query(
        `INSERT INTO organisation.operating_state (organisation_id, jurisdiction_code, telehealth_allowed, effective_from, created_by)
         VALUES ($1, $2, $3, $4::date, $5)
         ON CONFLICT (jurisdiction_code, effective_from) DO UPDATE SET telehealth_allowed = EXCLUDED.telehealth_allowed
         RETURNING jurisdiction_code AS "jurisdictionCode", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                   telehealth_allowed AS "telehealthAllowed", row_version::text AS "rowVersion"`,
        [tx.scope.orgId, code, allowed, from, tx.scope.principalId ?? null],
      );
      const row = norm(r.rows[0] as Row);
      if (before !== allowed)
        await this.changed(tx, meta, 'organisation.operating_state', null, null, {
          jurisdictionCode: code,
          effectiveFrom: from,
          before: before === undefined ? null : { telehealthAllowed: before },
          after: { telehealthAllowed: allowed },
        });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  // --- consent and questionnaire templates (drafts, then publish) ----------------------------------------------------------------

  private static readonly CONSENT_SELECT = `id, key, version, language, body_document_id AS "bodyDocumentId", status, row_version::text AS "rowVersion"`;
  private static readonly QUESTIONNAIRE_SELECT = `id, key, version, schema, status, approved_by_note AS "approvedByNote", row_version::text AS "rowVersion"`;

  private templateList(
    scope: ScopeSettings,
    table: string,
    cols: string,
    q: Record<string, unknown>,
  ): Promise<Page> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (q['key'] !== undefined) {
      if (typeof q['key'] !== 'string' || !KEY100.test(q['key'])) throw invalidField('key');
      params.push(q['key']);
      parts.push(`key = $${params.length}`);
    }
    if (q['status'] !== undefined) {
      if (!['draft', 'published', 'retired'].includes(String(q['status'])))
        throw invalidField('status');
      params.push(q['status']);
      parts.push(`status = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    return this.read(scope, (tx) =>
      this.page(
        tx,
        `SELECT ${cols} FROM ${table}${where} ORDER BY key, version DESC, id`,
        params,
        q,
      ),
    );
  }

  listConsentTemplates = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.templateList(
      s,
      'organisation.consent_template',
      OrganisationAdminService.CONSENT_SELECT,
      q,
    );
  listQuestionnaireTemplates = (s: ScopeSettings, q: Record<string, unknown>): Promise<Page> =>
    this.templateList(
      s,
      'organisation.questionnaire_template',
      OrganisationAdminService.QUESTIONNAIRE_SELECT,
      q,
    );

  /** POST: a new DRAFT version (the next number for the key and language). It has no effect until it is published. */
  async createConsentTemplate(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const v = parseFields(
      [
        f('key', 'key', 'text', { req: true, max: 100 }),
        f('language', 'language', 'text', { req: true, min: 2, max: 35 }),
        f('bodyDocumentId', 'body_document_id', 'uuid', { req: true }),
      ],
      asObject(body),
      'create',
    );
    if (!KEY100.test(v['key'] as string)) throw invalidField('key');
    return this.write(scope, async (tx) => {
      await lockKey(tx, `consent_template:${String(v['key'])}`);
      const id = uuidv7();
      const r = await tx.query(
        `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, body_document_id, status, created_by)
         SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4, $5, 'draft', $6
           FROM organisation.consent_template WHERE key = $3 AND language = $4
         RETURNING ${OrganisationAdminService.CONSENT_SELECT}`,
        [
          id,
          tx.scope.orgId,
          v['key'],
          v['language'],
          v['bodyDocumentId'],
          tx.scope.principalId ?? null,
        ],
      );
      const row = norm(r.rows[0] as Row);
      await this.changed(tx, meta, 'organisation.consent_template', id, null, {
        before: null,
        after: pick(row, ['key', 'version', 'language', 'bodyDocumentId', 'status']),
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  async createQuestionnaireTemplate(scope: ScopeSettings, body: unknown, meta: Meta): Promise<One> {
    const v = parseFields(
      [
        f('key', 'key', 'text', { req: true, max: 100 }),
        f('schema', 'schema', 'json', { req: true, max: MAX_SCHEMA_BYTES }),
      ],
      asObject(body),
      'create',
    );
    if (!KEY100.test(v['key'] as string)) throw invalidField('key');
    const schema = v['schema'] as Record<string, unknown>;
    const rules = schema['red_flag_rules'];
    if (
      rules !== undefined &&
      (!Array.isArray(rules) ||
        rules.length > 200 ||
        rules.some((x) => typeof x !== 'object' || x === null || Array.isArray(x)))
    )
      throw invalidField('schema');
    return this.write(scope, async (tx) => {
      await lockKey(tx, `questionnaire_template:${String(v['key'])}`);
      const id = uuidv7();
      const r = await tx.query(
        `INSERT INTO organisation.questionnaire_template (id, organisation_id, key, version, schema, status, created_by)
         SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4::jsonb, 'draft', $5
           FROM organisation.questionnaire_template WHERE key = $3
         RETURNING ${OrganisationAdminService.QUESTIONNAIRE_SELECT}`,
        [id, tx.scope.orgId, v['key'], JSON.stringify(schema), tx.scope.principalId ?? null],
      );
      const row = norm(r.rows[0] as Row);
      await this.changed(tx, meta, 'organisation.questionnaire_template', id, null, {
        before: null,
        after: {
          key: row['key'],
          version: row['version'],
          status: 'draft',
          redFlagRules: Array.isArray(rules) ? rules.length : 0,
        },
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  /** POST /{id}/publish: draft -> published. A consent version takes no body; a questionnaire version with red-flag rules needs the safety reviewer's note (BR-10, D-12a). */
  publishConsentTemplate(
    scope: ScopeSettings,
    id: string,
    body: unknown,
    meta: Meta,
  ): Promise<One> {
    if (!isUuid(id)) throw notFound();
    const extra = onlyKeys(asObject(body ?? {}), []);
    if (extra.length > 0) throw invalid(extra);
    return this.write(scope, async (tx) => {
      const r = await tx.query(
        `SELECT ${OrganisationAdminService.CONSENT_SELECT} FROM organisation.consent_template WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const before = r.rows[0] as Row | undefined;
      if (before === undefined) throw notFound();
      if (before['status'] !== 'draft') throw new ApiError(412, 'kernel.precondition_failed');
      await tx.query(
        `UPDATE organisation.consent_template SET status = 'published' WHERE id = $1`,
        [id],
      );
      const row = norm(
        (
          await tx.query(
            `SELECT ${OrganisationAdminService.CONSENT_SELECT} FROM organisation.consent_template WHERE id = $1`,
            [id],
          )
        ).rows[0] as Row,
      );
      await this.changed(tx, meta, 'organisation.consent_template', id, null, {
        key: row['key'],
        version: row['version'],
        before: { status: 'draft' },
        after: { status: 'published' },
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }

  publishQuestionnaireTemplate(
    scope: ScopeSettings,
    id: string,
    body: unknown,
    meta: Meta,
  ): Promise<One> {
    if (!isUuid(id)) throw notFound();
    const v = parseFields(
      [f('approvedByNote', 'approved_by_note', 'text', { min: 1, max: 1000 })],
      asObject(body ?? {}),
      'create',
    );
    return this.write(scope, async (tx) => {
      const r = await tx.query(
        `SELECT ${OrganisationAdminService.QUESTIONNAIRE_SELECT} FROM organisation.questionnaire_template WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const before = r.rows[0] as Row | undefined;
      if (before === undefined) throw notFound();
      if (before['status'] !== 'draft') throw new ApiError(412, 'kernel.precondition_failed');
      const rules = (before['schema'] as Record<string, unknown>)['red_flag_rules'];
      const ruleCount = Array.isArray(rules) ? rules.length : 0;
      const note = v['approvedByNote'] as string | undefined;
      if (ruleCount > 0 && (note === undefined || note.length < 10))
        throw invalid([{ path: '/approvedByNote', code: 'kernel.required' }]);
      await tx.query(
        `UPDATE organisation.questionnaire_template SET status = 'published', approved_by_note = coalesce($2, approved_by_note) WHERE id = $1`,
        [id, note ?? null],
      );
      const row = norm(
        (
          await tx.query(
            `SELECT ${OrganisationAdminService.QUESTIONNAIRE_SELECT} FROM organisation.questionnaire_template WHERE id = $1`,
            [id],
          )
        ).rows[0] as Row,
      );
      await this.changed(tx, meta, 'organisation.questionnaire_template', id, null, {
        key: row['key'],
        version: row['version'],
        redFlagRules: ruleCount,
        before: { status: 'draft' },
        after: { status: 'published', approvedByNote: note ?? null },
      });
      return { body: row, etag: etag(row['rowVersion'] as number) };
    });
  }
}
