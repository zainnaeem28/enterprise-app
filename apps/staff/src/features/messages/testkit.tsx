// CONTRACT MOCK of messaging.yaml for the messages and tasks tests. Response shapes are copied from the BE-19 service (`types.ts`,
// `controller.ts`). No real API or database runs in these tests.
import { act, fireEvent, render } from '@testing-library/react';
import axe from 'axe-core';
import { createApiClient } from '@ehr/app-shell';
import { MessagesPortal } from './index.js';

export const LOC = '11111111-1111-4111-8111-111111111111';
export const ME = '88888888-8888-4888-8888-888888888888';
export const OTHER = '99999999-9999-4999-8999-999999999999';
export const T1 = '33333333-3333-4333-8333-333333333333';
export const K1 = '55555555-5555-4555-8555-555555555555';

export const ALL = ['messaging.thread.staff', 'messaging.task.manage'];

export const userEvent = {
  click: async (el: Element) => {
    await act(async () => {
      fireEvent.click(el);
    });
  },
  set: async (el: Element, value: string) => {
    await act(async () => {
      fireEvent.change(el, { target: { value } });
    });
  },
};

export interface Req {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  search: URLSearchParams;
}
export type Handler = (req: Req) => Response | undefined;
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

export const thread = (over: Record<string, unknown> = {}) => ({
  id: T1,
  kind: 'staff',
  patientId: null,
  subject: 'Rota change',
  status: 'open',
  locationId: LOC,
  createdAt: '2031-06-01T09:00:00.000Z',
  version: 1,
  me: { role: 'owner', lastReadAt: null },
  unread: 2,
  ...over,
});
export const message = (id: string, from: string, body: string, sentAt: string) => ({
  id,
  threadId: T1,
  authorPrincipalId: from,
  body,
  attachmentDocumentIds: [],
  sentAt,
});
export const task = (over: Record<string, unknown> = {}) => ({
  id: K1,
  patientId: null,
  title: 'Call the lab',
  detail: null,
  assignee: { kind: 'principal', principalId: ME },
  status: 'open',
  dueAt: null,
  source: 'manual',
  completedAt: null,
  createdAt: '2031-06-01T09:00:00.000Z',
  version: 4,
  ...over,
});

export function mount(perms: string[], handler: Handler) {
  const seen: Req[] = [];
  const api = createApiClient({
    clientRelease: 'r1.000000000000',
    baseUrl: 'http://staff.test',
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.clone().text();
      const body = text === '' ? undefined : (JSON.parse(text) as unknown);
      const req = {
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body,
        search: url.searchParams,
      };
      seen.push(req);
      if (url.pathname === '/api/v1/auth/session')
        return json(200, {
          principalId: ME,
          displayName: 'Dr Lee',
          audience: 'staff',
          realm: 'google',
          csrfToken: 't',
          idleExpiresAt: '2031-06-10T12:00:00.000Z',
          roles: [{ key: 'doctor', locationId: LOC }],
          permissions: perms,
          patients: [],
        });
      return handler(req) ?? json(404, { code: 'kernel.not_found' });
    },
  });
  const view = render(<MessagesPortal runtime={{ api }} />);
  return { seen, view };
}

export async function violations(container: HTMLElement) {
  const r = await axe.run(container, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target).join(', ')}`,
  );
}
