// Test-only helpers: a CONTRACT MOCK of the scheduling, clinical, patient, documents and identity routes the pre-visit screens call.
// No real API, database or object store runs in these tests.
import { useState } from 'react';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { json, runtimeWith, SESSION } from '../../app/test-helpers.js';
import { PrevisitRoutes } from './PrevisitRoutes.js';

export const ME = '22222222-2222-4222-8222-222222222222';
export const RES = '33333333-3333-4333-8333-333333333333';
export const CONSENT = '44444444-4444-4444-8444-444444444444';
export const RESPONSE = '55555555-5555-4555-8555-555555555555';
export const DOC = '66666666-6666-4666-8666-666666666666';

export const etag = (v: number) => ({ etag: `W/"${v}"` });

export const previsitBody = (over: Record<string, unknown> = {}) => ({
  reservationId: RES,
  questionnaire: false,
  consents: false,
  insurance: false,
  requiredConsents: [
    {
      id: CONSENT,
      templateKey: 'telehealth',
      title: 'Telehealth consent',
      text: 'SYNTHETIC consent wording for tests.',
      status: 'pending',
    },
  ],
  ...over,
});

export const templateBody = () => ({
  key: 'general',
  version: 2,
  schema: {
    title: 'Health questionnaire',
    questions: [
      { id: 'chest_pain', label: 'Do you have chest pain now?', type: 'yesno' },
      { id: 'reason', label: 'Why are you coming in?', type: 'text' },
      {
        id: 'smoker',
        label: 'Do you smoke?',
        type: 'choice',
        options: ['never', 'former', 'current'],
      },
    ],
  },
});

export const forVisit = (response: unknown = null) => ({
  reservationId: RES,
  template: templateBody(),
  response,
});

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}
export type Route = (seen: Seen) => Response | undefined | Promise<Response | undefined>;

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
    };
    seen.push(entry);
    const key = `${request.method} ${url.pathname}`;
    // A key may hold `*` for one path segment (the response id is chosen by the page).
    const match = Object.keys(routes).find(
      (k) =>
        k === key || (k.includes('*') && new RegExp(`^${k.replace(/\*/g, '[^/]+')}$`).test(key)),
    );
    const answered = match === undefined ? undefined : await routes[match]!(entry);
    if (answered !== undefined) return answered;
    switch (key) {
      case 'GET /api/v1/auth/session':
        return json(200, {
          ...SESSION,
          patients: [{ patientId: ME, relation: 'self', scope: 'full' }],
        });
      case `GET /api/v1/appointments/${RES}/previsit`:
        return json(200, previsitBody());
      case `GET /api/v1/appointments/${RES}/questionnaire`:
        return json(200, forVisit());
      case `GET /api/v1/patients/${ME}/insurance-coverages`:
        return json(200, { items: [] });
      case `GET /api/v1/patients/${ME}/documents`:
        return json(200, { items: [] });
      default:
        return json(404, { status: 404, code: 'kernel.not_found', requestId: 'req-unmocked' });
    }
  };
  return { respond, seen };
}

function Harness({
  runtime,
  start,
}: {
  runtime: ReturnType<typeof runtimeWith>['runtime'];
  start: string;
}) {
  const [url, setUrl] = useState(start);
  return (
    <PrevisitRoutes
      runtime={runtime}
      path={new URL(url, 'http://portal.test').pathname}
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

export const sent = (seen: Seen[], method: string, path: string) =>
  seen.filter((s) => s.method === method && s.path === path);

export async function violations(container: HTMLElement) {
  const r = await axe.run(container, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target).join(', ')}`,
  );
}
