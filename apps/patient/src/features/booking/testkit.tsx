// Test-only helpers: a CONTRACT MOCK of the scheduling API (no real API or database runs in these unit tests) and a
// harness that owns the path the way the app's `useLocation` does.
import { useState } from 'react';
import { render } from '@testing-library/react';
import { BookingRoutes } from './BookingRoutes.js';
import { json, runtimeWith, SESSION } from '../../app/test-helpers.js';

export const PATIENT = '22222222-2222-4222-8222-222222222222';
export const SERVICE = '33333333-3333-4333-8333-333333333333';
export const PLACE = '44444444-4444-4444-8444-444444444444';
export const DOCTOR = '55555555-5555-4555-8555-555555555555';
export const RESERVATION = '66666666-6666-4666-8666-666666666666';

export const startsAt = (day: number, hour: number) =>
  new Date(Date.UTC(2031, 5, day, hour, 0, 0)).toISOString();

export const appointment = (over: Record<string, unknown> = {}) => ({
  id: RESERVATION,
  patientId: PATIENT,
  serviceId: SERVICE,
  locationId: PLACE,
  locationTimeZone: 'America/New_York',
  clinicianId: DOCTOR,
  roomId: null,
  mode: 'in_person',
  status: 'confirmed',
  startsAt: startsAt(10, 14),
  endsAt: startsAt(10, 15),
  expiresAt: null,
  reason: null,
  bookedVia: 'patient',
  rescheduledFromId: null,
  cancelReason: null,
  lateChange: null,
  version: 3,
  ...over,
});

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  query: URLSearchParams;
}

export type Route = (seen: Seen) => Response | undefined | Promise<Response | undefined>;

export const SLOTS = [
  {
    startsAt: startsAt(10, 14),
    endsAt: startsAt(10, 15),
    clinicianId: DOCTOR,
    locationId: PLACE,
    mode: 'in_person',
  },
  {
    startsAt: startsAt(10, 15),
    endsAt: startsAt(10, 16),
    clinicianId: DOCTOR,
    locationId: PLACE,
    mode: 'in_person',
  },
];

/** Answers every call the screens make; `routes` override by `"METHOD /path"`. */
export function mockApi(routes: Record<string, Route> = {}) {
  const seen: Seen[] = [];
  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const entry: Seen = {
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
      query: url.searchParams,
    };
    seen.push(entry);
    const key = `${request.method} ${url.pathname}`;
    const override = routes[key] ?? Object.entries(routes).find(([k]) => matches(k, key))?.[1];
    const answered = override === undefined ? undefined : await override(entry);
    if (answered !== undefined) return answered;
    switch (key) {
      case 'GET /api/v1/auth/session':
        return json(200, {
          ...SESSION,
          patients: [{ patientId: PATIENT, relation: 'self', scope: 'full' }],
        });
      case 'GET /api/v1/services':
        return json(200, {
          items: [
            { id: SERVICE, patientDisplayName: 'General visit', durationMin: 30, mode: null },
          ],
          nextCursor: null,
        });
      case 'GET /api/v1/locations':
        return json(200, {
          items: [{ id: PLACE, name: 'Main Street Clinic', timeZone: 'America/New_York' }],
          nextCursor: null,
        });
      case 'GET /api/v1/clinicians':
        return json(200, { items: [{ clinicianId: DOCTOR, displayName: 'Dr. Example' }] });
      case 'POST /api/v1/availability/search':
        return json(200, {
          slots: SLOTS.map((x) => ({ ...x, mode: entry.body?.['mode'] ?? x.mode })),
          availabilityStale: false,
        });
      case 'GET /api/v1/patients/' + PATIENT + '/appointments':
        return json(200, { items: [appointment()], nextCursor: null });
      case 'GET /api/v1/appointments/' + RESERVATION:
        return json(200, appointment());
      default:
        return json(404, { status: 404, code: 'kernel.not_found', requestId: 'req-unmocked' });
    }
  };
  return { respond, seen };
}

const matches = (pattern: string, key: string) =>
  pattern.includes('*') && new RegExp('^' + pattern.replace(/\*/g, '[^ ]*') + '$').test(key);

function Harness({
  runtime,
  start,
}: {
  runtime: Parameters<typeof BookingRoutes>[0]['runtime'];
  start: string;
}) {
  const [url, setUrl] = useState(start);
  const parsed = new URL(url, 'http://portal.test');
  return (
    <BookingRoutes
      runtime={runtime}
      path={parsed.pathname}
      params={parsed.searchParams}
      go={setUrl}
    />
  );
}

export function mount(start: string, routes: Record<string, Route> = {}) {
  const api = mockApi(routes);
  const h = runtimeWith(api.respond);
  const view = render(<Harness runtime={h.runtime} start={start} />);
  return { ...h, ...api, view };
}

export const posts = (seen: Seen[], path: string) =>
  seen.filter((s) => s.method === 'POST' && s.path === path);
