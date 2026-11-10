import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryUnavailable,
  createDirectoryClient,
  loadDirectory,
  parseLocation,
  parseNextSlot,
  parseService,
} from './directory.js';

const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('parsers drop malformed rows', () => {
  it('service', () => {
    expect(
      parseService({
        id: S,
        patientDisplayName: 'General visit',
        durationMin: 20,
        mode: 'in_person',
      }),
    ).toEqual({
      id: S,
      name: 'General visit',
      durationMin: 20,
      mode: 'in_person',
    });
    expect(
      parseService({ id: 'x', patientDisplayName: 'a', durationMin: 20, mode: 'm' }),
    ).toBeNull();
    expect(parseService({ id: S, patientDisplayName: '', durationMin: 20, mode: 'm' })).toBeNull();
    expect(parseService({ id: S, patientDisplayName: 'a', durationMin: -1, mode: 'm' })).toBeNull();
  });
  it('location takes known address parts only', () => {
    const l = parseLocation({
      id: L,
      name: 'Main',
      kind: 'clinic',
      timeZone: 'UTC',
      address: { line1: '1 Main St', city: 'Town', internalNote: 'secret' },
      stateCode: 'IL',
      geo: { lat: 1, lng: 2 },
      phone: null,
    });
    expect(l?.addressLines).toEqual(['1 Main St', 'Town']);
    expect(JSON.stringify(l)).not.toContain('secret');
    expect(parseLocation({ id: L, name: 'Main' })).toBeNull();
  });
  it('next slot', () => {
    expect(parseNextSlot({ startsAt: '2026-11-10T14:00:00Z' })).toEqual({
      state: 'slot',
      startsAt: '2026-11-10T14:00:00.000Z',
    });
    expect(parseNextSlot({ startsAt: null })).toEqual({ state: 'none' });
    expect(parseNextSlot({ startsAt: 'soon' })).toEqual({ state: 'unknown' });
    expect(parseNextSlot('x')).toEqual({ state: 'unknown' });
  });
});

describe('client cache and failure handling', () => {
  it('caches for the TTL, then refetches', async () => {
    let t = 0;
    const f = vi.fn(async () => ok({ items: [] }));
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
      now: () => t,
    });
    await c.services();
    await c.services();
    expect(f).toHaveBeenCalledTimes(1);
    t = 61_000;
    await c.services();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('serves the last answer when a refresh fails, until the stale limit', async () => {
    let t = 0;
    let fail = false;
    const f = vi.fn(async () =>
      fail
        ? new Response('', { status: 503 })
        : ok({ items: [{ clinicianId: D, displayName: 'Dr A' }] }),
    );
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
      now: () => t,
    });
    const fresh = { stale: false };
    expect(await c.clinicians({}, fresh)).toHaveLength(1);
    expect(fresh.stale).toBe(false);
    fail = true;
    t = 120_000;
    expect(await c.clinicians({}, fresh)).toHaveLength(1);
    expect(fresh.stale).toBe(true);
    t = 700_000;
    await expect(c.clinicians()).rejects.toBeInstanceOf(DirectoryUnavailable);
  });
  it('sends only allow-listed query parameters and never credentials', async () => {
    const f = vi.fn(async () => ok({ items: [] }));
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
    });
    await c.clinicians({ serviceId: S, locationId: L });
    const call = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(call[0].search).toBe(`?serviceId=${S}&locationId=${L}`);
    expect(Object.keys(call[1].headers as object)).toEqual(['accept']);
  });
  it('next slot: not found is "none", failure is "unknown", and a bad ID never calls the API', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 404 }));
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
    });
    expect(await c.nextAvailable(D, S)).toEqual({ state: 'none' });
    expect(await c.nextAvailable('bad', S)).toEqual({ state: 'unknown' });
    expect(f).toHaveBeenCalledTimes(1);
    const g = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });
    expect(await g.nextAvailable(D, S)).toEqual({ state: 'unknown' });
  });
  it('loadDirectory joins doctors with the services and locations they were returned for', async () => {
    const f = vi.fn(async (u: URL) => {
      const q = u.searchParams;
      if (u.pathname.endsWith('/services'))
        return ok({
          items: [{ id: S, patientDisplayName: 'Visit', durationMin: 10, mode: 'in_person' }],
        });
      if (u.pathname.endsWith('/locations'))
        return ok({
          items: [
            {
              id: L,
              name: 'Main',
              timeZone: 'UTC',
              address: null,
              geo: null,
              phone: null,
              stateCode: 'IL',
              kind: 'clinic',
            },
          ],
        });
      if (q.get('serviceId') === S || q.get('locationId') === L || q.size === 0)
        return ok({ items: [{ clinicianId: D, displayName: 'Dr A' }] });
      return ok({ items: [] });
    });
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
    });
    const dir = await loadDirectory(c);
    expect(dir.doctors).toEqual([{ id: D, name: 'Dr A', serviceIds: [S], locationIds: [L] }]);
  });
});

describe('maintenance banners', () => {
  const B = '44444444-4444-4444-8444-444444444444';
  it('keeps only id and message and drops malformed rows', async () => {
    const f = vi.fn(async () =>
      ok({
        items: [
          { id: B, message: 'Planned maintenance', startsAt: 'x', endsAt: 'y', extra: 'ignored' },
          { id: 'nope', message: 'bad id' },
          { id: B, message: '  ' },
        ],
        nextCursor: null,
      }),
    );
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
    });
    expect(await c.banners?.()).toEqual([{ id: B, message: 'Planned maintenance' }]);
  });
  it('returns none when the read fails', async () => {
    const f = vi.fn(async () => new Response(null, { status: 503 }));
    const c = createDirectoryClient({
      baseUrl: 'http://api',
      fetchFn: f as unknown as typeof fetch,
    });
    expect(await c.banners?.()).toEqual([]);
  });
});
