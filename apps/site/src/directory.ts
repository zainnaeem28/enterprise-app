// Server-side client of `GET /public/v1/services|locations|clinicians[/{id}/next-available]` (ARCHITECTURE 29.5).
// The site server is the only caller (SHARED-BOUNDARIES 5.1): the browser never reaches `integrations.`. Answers carry no PHI.
// Every answer is validated, a malformed row is dropped, and answers are cached for 60 s (the API's own `max-age`), so
// "next available" is at most about a minute old. A failed refresh serves the last answer for up to ten minutes (staleMs <= 600 s: a larger bound reopens PB-4);
// the caller learns of it through `Freshness` and must not let a CDN store what it built from that answer.
export interface Service {
  id: string;
  name: string;
  durationMin: number;
  mode: string;
}
export interface Location {
  id: string;
  name: string;
  kind: string;
  timeZone: string;
  addressLines: string[];
  stateCode: string;
  phone: string | null;
  geo: { lat: number; lng: number } | null;
}
export interface Clinician {
  id: string;
  name: string;
}
export type NextSlot =
  { state: 'slot'; startsAt: string } | { state: 'none' } | { state: 'unknown' };

export class DirectoryUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryUnavailable';
  }
}

/** Per-request record: `stale` turns true when any answer the request used came from the stale fallback. */
export interface Freshness {
  stale: boolean;
}

/** A current maintenance banner from `GET /public/v1/banners` (C0; exactly these fields are kept). */
export interface SiteBanner {
  id: string;
  message: string;
}

export function parseBanner(v: unknown): SiteBanner | null {
  if (!isRecord(v)) return null;
  const id = str(v['id']);
  const message = str(v['message']);
  if (id === null || !UUID_RE.test(id) || message === null) return null;
  return { id: id.toLowerCase(), message };
}

export interface DirectoryClient {
  /** Optional so existing fakes keep working; a missing or failing read means no banner, never a failed page. */
  banners?(): Promise<SiteBanner[]>;
  services(q?: { locationId?: string }, fresh?: Freshness): Promise<Service[]>;
  locations(fresh?: Freshness): Promise<Location[]>;
  clinicians(
    q?: { serviceId?: string; locationId?: string },
    fresh?: Freshness,
  ): Promise<Clinician[]>;
  nextAvailable(clinicianId: string, serviceId: string, fresh?: Freshness): Promise<NextSlot>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function items(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body['items'])) throw new DirectoryUnavailable('bad_shape');
  return body['items'];
}

export function parseService(v: unknown): Service | null {
  if (!isRecord(v)) return null;
  const id = str(v['id']);
  const name = str(v['patientDisplayName']);
  const mode = str(v['mode']);
  const dur = v['durationMin'];
  if (id === null || !UUID_RE.test(id) || name === null || mode === null) return null;
  if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) return null;
  return { id: id.toLowerCase(), name, durationMin: dur, mode };
}

/** The address column is JSON of an unfixed shape: take the known string parts, in reading order, and nothing else. */
function addressLines(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
  if (!isRecord(v)) return [];
  const pick = (...keys: string[]) =>
    keys
      .map((k) => str(v[k]))
      .filter((s): s is string => s !== null)
      .join(', ');
  return [
    pick('line1', 'street', 'address1'),
    pick('line2', 'address2'),
    pick('city', 'postalCode', 'zip'),
  ].filter((s) => s !== '');
}

function geoOf(v: unknown): Location['geo'] {
  if (!isRecord(v)) return null;
  const lat = v['lat'] ?? v['latitude'];
  const lng = v['lng'] ?? v['lon'] ?? v['longitude'];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function parseLocation(v: unknown): Location | null {
  if (!isRecord(v)) return null;
  const id = str(v['id']);
  const name = str(v['name']);
  const timeZone = str(v['timeZone']);
  if (id === null || !UUID_RE.test(id) || name === null || timeZone === null) return null;
  return {
    id: id.toLowerCase(),
    name,
    kind: str(v['kind']) ?? 'clinic',
    timeZone,
    addressLines: addressLines(v['address']),
    stateCode: str(v['stateCode']) ?? '',
    phone: str(v['phone']),
    geo: geoOf(v['geo']),
  };
}

export function parseClinician(v: unknown): Clinician | null {
  if (!isRecord(v)) return null;
  const id = str(v['clinicianId']);
  const name = str(v['displayName']);
  if (id === null || !UUID_RE.test(id) || name === null) return null;
  return { id: id.toLowerCase(), name };
}

/** The next-available body is an open object in the contract: accept an ISO start time under a few names, nothing else. */
export function parseNextSlot(body: unknown): NextSlot {
  if (!isRecord(body)) return { state: 'unknown' };
  const raw = body['startsAt'] ?? body['start'] ?? body['startTime'] ?? body['nextAvailable'];
  if (raw === null || raw === undefined) return { state: 'none' };
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return { state: 'unknown' };
  return { state: 'slot', startsAt: new Date(raw).toISOString() };
}

export interface DirectoryOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  ttlMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createDirectoryClient(o: DirectoryOptions): DirectoryClient {
  const fetchFn = o.fetchFn ?? fetch;
  const ttl = o.ttlMs ?? 60_000;
  const stale = o.staleMs ?? 600_000;
  const timeout = o.timeoutMs ?? 3_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; body: unknown }>();
  const inflight = new Map<string, Promise<{ body: unknown; stale: boolean }>>();

  async function get(
    path: string,
    query: Record<string, string | undefined> = {},
    fresh?: Freshness,
  ): Promise<unknown> {
    const r = await fetchOrCache(path, query);
    if (r.stale && fresh !== undefined) fresh.stale = true;
    return r.body;
  }

  async function fetchOrCache(
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<{ body: unknown; stale: boolean }> {
    const u = new URL(path, o.baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    const key = u.pathname + u.search;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttl) return { body: hit.body, stale: false };
    const running = inflight.get(key);
    if (running !== undefined) return running;
    const p = (async () => {
      try {
        const res = await fetchFn(u, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
          redirect: 'error',
        });
        if (res.status === 404) {
          cache.set(key, { at: now(), body: { notFound: true } });
          return { body: { notFound: true }, stale: false };
        }
        if (!res.ok) throw new DirectoryUnavailable(`status_${res.status}`);
        const body: unknown = await res.json();
        cache.set(key, { at: now(), body });
        return { body, stale: false };
      } catch (e) {
        if (hit !== undefined && now() - hit.at < stale) return { body: hit.body, stale: true };
        throw e instanceof DirectoryUnavailable ? e : new DirectoryUnavailable('network');
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  const parseAll = <T>(body: unknown, f: (v: unknown) => T | null): T[] =>
    items(body)
      .map(f)
      .filter((x): x is T => x !== null);

  return {
    async services(q = {}, fresh) {
      return parseAll(
        await get('/public/v1/services', { locationId: q.locationId }, fresh),
        parseService,
      );
    },
    async banners() {
      try {
        return parseAll(await get('/public/v1/banners'), parseBanner);
      } catch {
        return [];
      }
    },
    async locations(fresh) {
      return parseAll(await get('/public/v1/locations', {}, fresh), parseLocation);
    },
    async clinicians(q = {}, fresh) {
      return parseAll(
        await get(
          '/public/v1/clinicians',
          { serviceId: q.serviceId, locationId: q.locationId },
          fresh,
        ),
        parseClinician,
      );
    },
    async nextAvailable(clinicianId, serviceId, fresh) {
      if (!UUID_RE.test(clinicianId) || !UUID_RE.test(serviceId)) return { state: 'unknown' };
      try {
        const body = await get(
          `/public/v1/clinicians/${clinicianId}/next-available`,
          { serviceId },
          fresh,
        );
        if (isRecord(body) && body['notFound'] === true) return { state: 'none' };
        return parseNextSlot(body);
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}

/** A doctor as the site shows one: the listed clinician plus the services and locations the intersection query returned. */
export interface Doctor extends Clinician {
  serviceIds: string[];
  locationIds: string[];
}
export interface Directory {
  services: Service[];
  locations: Location[];
  doctors: Doctor[];
}

const MAX_FANOUT = 24;

export async function loadDirectory(c: DirectoryClient, fresh?: Freshness): Promise<Directory> {
  const [services, locations, clinicians] = await Promise.all([
    c.services({}, fresh),
    c.locations(fresh),
    c.clinicians({}, fresh),
  ]);
  const byService = await Promise.all(
    services
      .slice(0, MAX_FANOUT)
      .map(async (s) => [s.id, await c.clinicians({ serviceId: s.id }, fresh)] as const),
  );
  const byLocation = await Promise.all(
    locations
      .slice(0, MAX_FANOUT)
      .map(async (l) => [l.id, await c.clinicians({ locationId: l.id }, fresh)] as const),
  );
  const doctors = clinicians.map<Doctor>((d) => ({
    ...d,
    serviceIds: byService.filter(([, list]) => list.some((x) => x.id === d.id)).map(([id]) => id),
    locationIds: byLocation.filter(([, list]) => list.some((x) => x.id === d.id)).map(([id]) => id),
  }));
  return { services, locations, doctors };
}
