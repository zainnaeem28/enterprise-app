import { arr, num, rec, str, strOrNull } from '../preconsult/http.js';

export type Mode = 'in_person' | 'video' | 'either';
export type BlockedKind = 'leave' | 'blocked' | 'admin';
export type LinkStatus = 'not_linked' | 'pending_consent' | 'active' | 'token_revoked' | 'error';

export interface Rule {
  id?: string;
  /** 0 = Sunday .. 6 = Saturday, in the local time of the template's location. */
  weekday: number;
  startLocal: string;
  endLocal: string;
  /** Kept as the server sent it: this screen does not edit services, rooms or overbooking (see README). */
  serviceIds: string[] | null;
  mode: Mode;
  roomId: string | null;
  overbookable: boolean;
}

export interface Template {
  id: string;
  clinicianId: string;
  locationId: string;
  validFrom: string;
  validTo: string | null;
  status: 'active' | 'retired';
  rules: Rule[];
  version: number;
}

export interface Blocked {
  id: string;
  startsAt: string;
  endsAt: string;
  kind: BlockedKind;
  note: string | null;
  version: number;
}

/** Counts only: an occupancy row carries no patient (ARCHITECTURE 29.3). */
export interface Conflicts {
  total: number;
  held: number;
  confirmed: number;
  checked_in: number;
}

export interface BlockedSaved {
  saved: boolean;
  blocked?: Blocked;
  conflicts: Conflicts;
}

export interface LinkView {
  status: LinkStatus;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
}

export interface DayVisit {
  startsAt: string;
  endsAt: string;
  status: string;
}
export interface DaySchedule {
  items: DayVisit[];
  timeZone: string;
}

const MODES: readonly string[] = ['in_person', 'video', 'either'];
const KINDS: readonly string[] = ['leave', 'blocked', 'admin'];
const LINKS: readonly string[] = [
  'not_linked',
  'pending_consent',
  'active',
  'token_revoked',
  'error',
];

export function parseRule(v: unknown): Rule | undefined {
  const r = rec(v);
  const weekday = num(r['weekday']);
  const startLocal = str(r['startLocal']);
  const endLocal = str(r['endLocal']);
  const mode = str(r['mode']);
  if (
    weekday === undefined ||
    startLocal === undefined ||
    endLocal === undefined ||
    mode === undefined ||
    !MODES.includes(mode)
  )
    return undefined;
  const ids = r['serviceIds'];
  const id = str(r['id']);
  return {
    ...(id === undefined ? {} : { id }),
    weekday,
    startLocal: startLocal.slice(0, 5),
    endLocal: endLocal.slice(0, 5),
    serviceIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null,
    mode: mode as Mode,
    roomId: strOrNull(r['roomId']),
    overbookable: r['overbookable'] === true,
  };
}

export function parseTemplate(v: unknown): Template | undefined {
  const r = rec(v);
  const id = str(r['id']);
  const clinicianId = str(r['clinicianId']);
  const locationId = str(r['locationId']);
  const validFrom = str(r['validFrom']);
  const version = num(r['version']);
  const status = r['status'];
  if (
    id === undefined ||
    clinicianId === undefined ||
    locationId === undefined ||
    validFrom === undefined ||
    version === undefined ||
    (status !== 'active' && status !== 'retired') ||
    !Array.isArray(r['rules'])
  )
    return undefined;
  const rules = arr(r['rules']).map(parseRule);
  if (rules.some((x) => x === undefined)) return undefined;
  return {
    id,
    clinicianId,
    locationId,
    validFrom: validFrom.slice(0, 10),
    validTo: typeof r['validTo'] === 'string' ? r['validTo'].slice(0, 10) : null,
    status,
    rules: rules as Rule[],
    version,
  };
}

export function parseBlocked(v: unknown): Blocked | undefined {
  const r = rec(v);
  const id = str(r['id']);
  const startsAt = str(r['startsAt']);
  const endsAt = str(r['endsAt']);
  const kind = str(r['kind']);
  const version = num(r['version']);
  if (
    id === undefined ||
    startsAt === undefined ||
    endsAt === undefined ||
    kind === undefined ||
    !KINDS.includes(kind) ||
    version === undefined
  )
    return undefined;
  return { id, startsAt, endsAt, kind: kind as BlockedKind, note: strOrNull(r['note']), version };
}

export function parseConflicts(v: unknown): Conflicts | undefined {
  const r = rec(v);
  const total = num(r['total']);
  if (total === undefined) return undefined;
  return {
    total,
    held: num(r['held']) ?? 0,
    confirmed: num(r['confirmed']) ?? 0,
    checked_in: num(r['checked_in']) ?? 0,
  };
}

export function parseBlockedSaved(v: unknown): BlockedSaved | undefined {
  const r = rec(v);
  const conflicts = parseConflicts(r['conflicts']);
  if (conflicts === undefined || typeof r['saved'] !== 'boolean') return undefined;
  if (!r['saved']) return { saved: false, conflicts };
  const blocked = parseBlocked(r);
  return blocked === undefined ? undefined : { saved: true, blocked, conflicts };
}

/** The 409 `scheduling.conflicts_with_appointments` body carries `errors: [{ path: '/conflicts/<status>', code: '<count>' }]`. */
export function conflictsFromError(body: unknown): Conflicts | undefined {
  const c: Record<string, number> = {};
  for (const e of arr(rec(body)['errors']).map(rec)) {
    const m = /^\/conflicts\/(\w+)$/.exec(str(e['path']) ?? '');
    const n = Number(e['code']);
    if (m !== null && Number.isFinite(n)) c[m[1] as string] = n;
  }
  const total = c['total'] ?? (c['held'] ?? 0) + (c['confirmed'] ?? 0) + (c['checked_in'] ?? 0);
  return parseConflicts({ ...c, total });
}

export function parseLink(v: unknown): LinkView | undefined {
  const r = rec(v);
  const status = str(r['status']);
  if (status === undefined || !LINKS.includes(status)) return undefined;
  return {
    status: status as LinkStatus,
    lastSyncedAt: strOrNull(r['lastSyncedAt']),
    lastErrorCode: strOrNull(r['lastErrorCode']),
  };
}

export function parseDay(v: unknown): DaySchedule | undefined {
  const r = rec(v);
  const tz = str(r['timeZone']);
  if (tz === undefined || !Array.isArray(r['items'])) return undefined;
  const items: DayVisit[] = [];
  for (const x of arr(r['items']).map(rec)) {
    const startsAt = str(x['startsAt']);
    const endsAt = str(x['endsAt']);
    const status = str(x['status']);
    if (startsAt === undefined || endsAt === undefined || status === undefined) return undefined;
    items.push({ startsAt, endsAt, status });
  }
  return { items, timeZone: tz };
}
