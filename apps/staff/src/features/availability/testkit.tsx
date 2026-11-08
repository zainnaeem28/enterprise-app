// CONTRACT MOCK of scheduling.yaml and calendar-sync.yaml for the availability tests. Response shapes are copied from the API controllers
// on the BE-12 and BE-14 branches (`controller.ts`, `types.ts`, `service.ts`). No real API, database or Google service runs in these tests.
import { act, fireEvent, render } from '@testing-library/react';
import { createApiClient } from '@ehr/app-shell';
import { AvailabilityPortal } from './index.js';

export const LOC = '11111111-1111-4111-8111-111111111111';
export const ME = '88888888-8888-4888-8888-888888888888';
export const TPL = '33333333-3333-4333-8333-333333333333';
export const BLK = '55555555-5555-4555-8555-555555555555';

export const DOCTOR = [
  'scheduling.booking.own_schedule',
  'scheduling.template.manage',
  'scheduling.blocked_time.manage',
  'calendar.link.own',
];

export const userEvent = {
  setup: () => ({
    click: async (el: Element) => {
      await act(async () => {
        fireEvent.click(el);
      });
    },
    type: async (el: Element, text: string) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(input, { target: { value: input.value + text } });
      });
    },
    set: async (el: Element, value: string) => {
      await act(async () => {
        fireEvent.change(el, { target: { value } });
      });
    },
  }),
};

export type Handler = (req: {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  search: URLSearchParams;
}) => Response | undefined;
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  search: string;
}

export const rule = (weekday: number, over: Record<string, unknown> = {}) => ({
  id: `r-${weekday}`,
  weekday,
  startLocal: '09:00',
  endLocal: '17:00',
  serviceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  mode: 'either',
  roomId: null,
  overbookable: false,
  ...over,
});

export const template = (weekdays: number[], over: Record<string, unknown> = {}) => ({
  id: TPL,
  clinicianId: ME,
  locationId: LOC,
  validFrom: '2020-01-01',
  validTo: null,
  status: 'active',
  rules: weekdays.map((w) => rule(w)),
  version: 3,
  ...over,
});

export const blocked = (over: Record<string, unknown> = {}) => ({
  id: BLK,
  clinicianId: ME,
  startsAt: '2031-07-01T00:00:00.000Z',
  endsAt: '2031-07-08T00:00:00.000Z',
  kind: 'leave',
  note: 'Annual leave',
  version: 1,
  ...over,
});

export function mount(
  perms: string[],
  handler: Handler,
  opts: { search?: string; go?: (url: string) => void; locations?: string[] } = {},
) {
  const seen: Seen[] = [];
  const api = createApiClient({
    clientRelease: 'r1.000000000000',
    baseUrl: 'http://staff.test',
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.clone().text();
      const body = text === '' ? undefined : (JSON.parse(text) as unknown);
      seen.push({
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body,
        search: url.search,
      });
      if (url.pathname === '/api/v1/auth/session')
        return json(200, {
          principalId: ME,
          displayName: 'Dr Lee',
          audience: 'staff',
          realm: 'google',
          csrfToken: 't',
          idleExpiresAt: '2031-06-10T12:00:00.000Z',
          roles: (opts.locations ?? [LOC]).map((locationId) => ({ key: 'doctor', locationId })),
          permissions: perms,
          patients: [],
        });
      return (
        handler({
          method: request.method,
          path: url.pathname,
          headers: request.headers,
          body,
          search: url.searchParams,
        }) ?? json(404, { code: 'kernel.not_found' })
      );
    },
  });
  const view = render(
    <AvailabilityPortal
      runtime={{ api }}
      {...(opts.search === undefined ? {} : { search: opts.search })}
      go={opts.go ?? (() => undefined)}
    />,
  );
  return { seen, view };
}
