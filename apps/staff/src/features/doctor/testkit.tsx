// CONTRACT MOCK of clinical.yaml, notifications.yaml, scheduling.yaml and patient.yaml for the doctor portal tests. Response shapes are copied
// from the API controllers on the prerequisite branches. No real API, database or identity provider runs in these tests.
import { act, fireEvent, render } from '@testing-library/react';
import { createApiClient } from '@ehr/app-shell';
import { DoctorPortal } from './index.js';
import type { DoctorPath, VideoAdapter } from './index.js';
import { FakeStream } from './fake-stream.js';

export { FakeStream };
export const LOC = '11111111-1111-4111-8111-111111111111';
export const PAT = '22222222-2222-4222-8222-222222222222';
export const RES = '44444444-4444-4444-8444-444444444444';
export const ENC = '66666666-6666-4666-8666-666666666666';
export const NOTE = '77777777-7777-4777-8777-777777777777';
export const ME = '88888888-8888-4888-8888-888888888888';
export const ALERT = '99999999-9999-4999-8999-999999999999';

export const DOCTOR = [
  'clinical.chart.read',
  'clinical.chart.read_previsit',
  'clinical.consultation.start',
  'clinical.note.write',
  'clinical.note.sign',
  'audit.btg.open',
  'notifications.alert.read',
  'notifications.alert.acknowledge',
  'patient.read',
  'scheduling.check_in',
];
export const TRAINEE = DOCTOR.filter((p) => p !== 'clinical.note.sign' && p !== 'audit.btg.open');
export const SUPERVISOR = [...DOCTOR, 'clinical.note.cosign'];

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
}

export const banner = (over: Record<string, unknown> = {}) => ({
  patientId: PAT,
  displayName: 'Amira Okafor',
  dateOfBirth: '1984-03-09',
  mrn: 'MRN-0000123',
  photoUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  allergies: {
    state: 'recorded',
    items: [
      { allergyId: 'a1', display: 'Penicillin', category: 'drug', severity: 'severe', coded: true },
    ],
    moreCount: 0,
    uncodedCount: 0,
    lastChangedAt: null,
  },
  ...over,
});

export const summary = (over: Record<string, unknown> = {}) => ({
  patientBanner: banner(),
  level: 'chart',
  problems: [
    { id: 'p1', display: 'Asthma', coded: true, status: 'active', onsetDate: '2019-01-01' },
  ],
  allergies: [
    {
      id: 'a1',
      display: 'Penicillin',
      coded: true,
      status: 'active',
      severity: 'severe',
      reaction: 'Rash',
    },
  ],
  medications: [
    {
      id: 'm1',
      display: 'Salbutamol inhaler',
      coded: false,
      status: 'active',
      doseText: '2 puffs as needed',
    },
  ],
  recentVitals: [
    {
      vitalId: 'v1',
      loincCode: '8867-4',
      value: 118,
      unit: '/min',
      measuredAt: '2031-06-10T08:55:00.000Z',
      rangeStatus: 'out_of_range',
      rangeLow: 50,
      rangeHigh: 100,
      correctsId: null,
      enteredInError: false,
    },
  ],
  encounters: [],
  documents: [],
  ...over,
});

export const note = (over: Record<string, unknown> = {}) => ({
  id: NOTE,
  encounterId: ENC,
  patientId: PAT,
  authorPrincipalId: ME,
  templateId: 'soap',
  body: { sections: { subjective: '', objective: '', assessment: '', plan: '' } },
  status: 'draft',
  submittedForCosignAt: null,
  cosignRequiredFrom: null,
  signedAt: null,
  signedBy: null,
  cosignedAt: null,
  createdAt: '2031-06-10T09:00:00.000Z',
  version: 1,
  patientBanner: banner(),
  ...over,
});

export const encounter = () => ({
  id: ENC,
  patientId: PAT,
  locationId: LOC,
  reservationId: RES,
  clinicianPrincipalId: ME,
  mode: 'in_person',
  status: 'in_consultation',
  startedAt: '2031-06-10T09:00:00.000Z',
  endedAt: null,
  noteDeferredReason: null,
  version: 2,
  consentExceptionId: null,
  patientBanner: banner(),
});

export const visit = (over: Record<string, unknown> = {}) => ({
  reservationId: RES,
  patientId: PAT,
  patientName: 'Amira Okafor',
  mrn: 'MRN-0000123',
  serviceId: 's',
  clinicianId: ME,
  mode: 'in_person',
  status: 'checked_in',
  startsAt: '2031-06-10T09:00:00.000Z',
  endsAt: '2031-06-10T09:30:00.000Z',
  queueStage: 'ready',
  version: 3,
  ...over,
});

export function mount(
  perms: string[],
  path: DoctorPath,
  handler: Handler,
  opts: { video?: VideoAdapter; stream?: FakeStream; roles?: string[] } = {},
) {
  const seen: Seen[] = [];
  const stream = opts.stream ?? new FakeStream();
  const api = createApiClient({
    clientRelease: 'r1.000000000000',
    baseUrl: 'http://staff.test',
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.clone().text();
      const body = text === '' ? undefined : (JSON.parse(text) as unknown);
      seen.push({ method: request.method, path: url.pathname, headers: request.headers, body });
      if (url.pathname === '/api/v1/auth/session')
        return json(200, {
          principalId: ME,
          displayName: 'Dr Lee',
          audience: 'staff',
          realm: 'google',
          csrfToken: 't',
          idleExpiresAt: '2031-06-10T12:00:00.000Z',
          roles: (opts.roles ?? ['doctor']).map((key) => ({ key, locationId: LOC })),
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
  const navigated: string[] = [];
  const view = render(
    <DoctorPortal
      runtime={{ api }}
      path={path}
      navigate={(p) => navigated.push(p)}
      stream={() => stream}
      {...(opts.video === undefined ? {} : { video: opts.video })}
    />,
  );
  return { seen, navigated, stream, view };
}
