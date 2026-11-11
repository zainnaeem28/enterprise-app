// Test-only helpers: a CONTRACT MOCK of the patient, identity, privacy and messaging APIs (no real API or database runs in the
// unit tests) and harnesses that own the path the way the app's `useLocation` does.
import { useState } from 'react';
import { render } from '@testing-library/react';
import { json, runtimeWith, SESSION } from '../../app/test-helpers.js';
import type { PatientRuntime } from '../../app/runtime.js';
import { MessagesRoutes } from '../messages/MessagesRoutes.js';
import { PrivacyRoutes } from '../privacy/PrivacyRoutes.js';
import { ProfileRoutes } from './ProfileRoutes.js';

export const ME = '22222222-2222-4222-8222-222222222222';
export const OTHER = '77777777-7777-4777-8777-777777777777';
export const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
export const GRANT = '88888888-8888-4888-8888-888888888888';
export const REQUEST = '99999999-9999-4999-8999-999999999999';
export const THREAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const profileBody = (over: Record<string, unknown> = {}) => ({
  id: ME,
  givenName: 'Sam',
  familyName: 'Example',
  dateOfBirth: '1990-04-12',
  phone: '+15550100100',
  email: 'sam@example.test',
  address: { line1: '1 Test Street', city: 'Testville', postalCode: '10001' },
  stateCode: 'AA',
  preferredLanguage: 'en',
  preferredPharmacy: { name: 'Corner Pharmacy' },
  version: 3,
  contacts: [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      kind: 'emergency',
      name: 'Alex Example',
      relationship: 'sibling',
      phone: '+15550100200',
      email: null,
      rowVersion: 2,
    },
  ],
  ...over,
});

export const prefsBody = (over: Record<string, unknown> = {}) => ({
  patientId: ME,
  channels: ['email', 'in_app'],
  reminderChannel: null,
  language: 'en',
  quietHours: null,
  marketingOptIn: false,
  stored: true,
  rowVersion: 4,
  ...over,
});

export const requestBody = (over: Record<string, unknown> = {}) => ({
  id: REQUEST,
  patientId: ME,
  kind: 'export',
  channel: 'portal',
  status: 'received',
  detail: null,
  decisionReason: null,
  dueAt: '2031-07-10T12:00:00.000Z',
  createdAt: '2031-06-10T12:00:00.000Z',
  package: null,
  version: 1,
  ...over,
});

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}
export type Route = (seen: Seen) => Response | undefined | Promise<Response | undefined>;

export const etag = (v: number) => ({ etag: `W/"${v}"` });

/** Answers every call the screens make; `routes` override by `"METHOD /path"`. */
export function mockApi(
  routes: Record<string, Route> = {},
  patients: unknown[] = [{ patientId: ME, relation: 'self', scope: 'full' }],
) {
  const seen: Seen[] = [];
  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const entry: Seen = {
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
    };
    seen.push(entry);
    const key = `${request.method} ${url.pathname}`;
    const answered = routes[key] === undefined ? undefined : await routes[key](entry);
    if (answered !== undefined) return answered;
    switch (key) {
      case 'GET /api/v1/auth/session':
        return json(200, { ...SESSION, patients });
      case `GET /api/v1/patients/${ME}/profile`:
        return json(200, profileBody(), etag(3));
      case `GET /api/v1/patients/${ME}/communication-preferences`:
        return json(200, prefsBody(), etag(4));
      case `GET /api/v1/patients/${ME}/proxies`:
        return json(200, { items: [], nextCursor: null });
      case 'GET /api/v1/privacy-requests':
        return json(200, { items: [], nextCursor: null });
      case `GET /api/v1/patients/${ME}/threads`:
        return json(200, { items: [], nextCursor: null });
      default:
        return json(404, { status: 404, code: 'kernel.not_found', requestId: 'req-unmocked' });
    }
  };
  return { respond, seen };
}

type Kind = 'profile' | 'privacy' | 'messages';

function Harness({
  runtime,
  start,
  kind,
  recipients,
  open,
}: {
  runtime: PatientRuntime;
  start: string;
  kind: Kind;
  recipients?: string[];
  open?: (url: string) => void;
}) {
  const [url, setUrl] = useState(start);
  const parsed = new URL(url, 'http://portal.test');
  if (kind === 'profile')
    return <ProfileRoutes runtime={runtime} path={parsed.pathname} go={setUrl} />;
  if (kind === 'privacy')
    return <PrivacyRoutes runtime={runtime} path={parsed.pathname} {...(open ? { open } : {})} />;
  return (
    <MessagesRoutes
      runtime={runtime}
      path={parsed.pathname}
      go={setUrl}
      {...(recipients ? { recipientPrincipalIds: recipients } : {})}
    />
  );
}

export function mount(
  kind: Kind,
  start: string,
  routes: Record<string, Route> = {},
  opts: { patients?: unknown[]; recipients?: string[]; open?: (url: string) => void } = {},
) {
  const api = mockApi(routes, opts.patients);
  const h = runtimeWith(api.respond);
  const view = render(
    <Harness
      runtime={h.runtime}
      start={start}
      kind={kind}
      {...(opts.recipients ? { recipients: opts.recipients } : {})}
      {...(opts.open ? { open: opts.open } : {})}
    />,
  );
  return { ...h, ...api, view };
}

export const sent = (seen: Seen[], method: string, path: string) =>
  seen.filter((s) => s.method === method && s.path === path);
