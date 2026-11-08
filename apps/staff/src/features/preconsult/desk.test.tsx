// CONTRACT MOCK of scheduling.yaml, clinical.yaml and patient.yaml (no real API, no database). The response shapes are copied from the
// API controllers on the prerequisite branches; the real journey is for integration (INT-03).
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createApiClient } from '@ehr/app-shell';
import { PreconsultDesk } from './index.js';
import type { PreconsultPath } from './index.js';
import { selection } from './DeskContext.js';

// `@testing-library/user-event` is not a dependency of this app and dependency changes are outside this ticket: a small subset over fireEvent.
const userEvent = {
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
    selectOptions: async (el: Element, value: string) => {
      await act(async () => {
        fireEvent.change(el, { target: { value } });
      });
    },
  }),
};

afterEach(() => {
  cleanup();
  selection.set(null);
});

const LOC = '11111111-1111-4111-8111-111111111111';
const PAT = '22222222-2222-4222-8222-222222222222';
const PAT2 = '33333333-3333-4333-8333-333333333333';
const RES = '44444444-4444-4444-8444-444444444444';
const MERGE = '55555555-5555-4555-8555-555555555555';

const FRONT_DESK = [
  'scheduling.check_in',
  'scheduling.queue.manage',
  'patient.read',
  'patient.match',
  'patient.register',
  'clinical.referral.manage',
];
const NURSE = [
  'scheduling.queue.manage',
  'clinical.vitals.record',
  'clinical.triage.record',
  'clinical.chart.read_previsit',
  'patient.read',
];

const arrival = (over: Record<string, unknown> = {}) => ({
  reservationId: RES,
  patientId: PAT,
  patientName: 'Amira Okafor',
  mrn: 'MRN-0000123',
  serviceId: 's',
  clinicianId: 'c',
  mode: 'in_person',
  status: 'confirmed',
  startsAt: '2031-06-10T09:00:00.000Z',
  endsAt: '2031-06-10T09:30:00.000Z',
  checkedInAt: null,
  method: null,
  queueStage: null,
  previsit: null,
  noShowCandidate: false,
  flaggedForStaff: false,
  version: 3,
  ...over,
});

type Handler = (req: {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  search: URLSearchParams;
}) => Response | undefined;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function mount(
  perms: string[],
  path: PreconsultPath,
  handler: Handler,
  locations: (string | undefined)[] = [LOC],
) {
  const seen: Seen[] = [];
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
          displayName: 'Dana',
          audience: 'staff',
          realm: 'google',
          csrfToken: 't',
          idleExpiresAt: '2031-06-10T12:00:00.000Z',
          roles: locations.map((l) => ({
            key: 'front_desk',
            ...(l === undefined ? {} : { locationId: l }),
          })),
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
  render(<PreconsultDesk runtime={{ api }} path={path} navigate={(p) => navigated.push(p)} />);
  return { seen, navigated };
}

describe('arrivals board and check-in (PC-01, PC-02)', () => {
  it("lists today's visits with the three pre-visit items in words", async () => {
    mount(FRONT_DESK, '/arrivals', (r) =>
      r.path.endsWith('/arrivals')
        ? json(200, {
            items: [
              arrival({
                checkedInAt: '2031-06-10T08:50:00.000Z',
                method: 'qr',
                previsit: { questionnaire: true, consents: false, insurance: true },
              }),
            ],
            nextCursor: null,
          })
        : undefined,
    );
    const table = await screen.findByRole('table', { name: 'Arrivals today' });
    expect(within(table).getByText('Amira Okafor')).toBeVisible();
    expect(within(table).getByText(/Checked in \(by QR code\)/)).toBeVisible();
    expect(within(table).getByText(/Questionnaire: done/)).toBeVisible();
    expect(within(table).getByText(/Consents: to do/)).toBeVisible();
    expect(within(table).getByText(/Insurance: done/)).toBeVisible();
  });

  it('checks a visit in with the visit version as If-Match and a fresh idempotency key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { seen } = mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) {
        calls += 1;
        return json(200, {
          items: [
            calls === 1
              ? arrival()
              : arrival({
                  checkedInAt: '2031-06-10T09:01:00.000Z',
                  method: 'desk',
                  version: 4,
                  previsit: { questionnaire: false, consents: false, insurance: false },
                }),
          ],
          nextCursor: null,
        });
      }
      if (r.path === `/api/v1/appointments/${RES}/check-in`)
        return json(200, {
          reservationId: RES,
          patientId: PAT,
          locationId: LOC,
          method: 'desk',
          checkedInAt: '2031-06-10T09:01:00.000Z',
          queueEntryId: RES,
          previsit: { questionnaire: false, consents: false, insurance: false },
          alreadyCheckedIn: false,
        });
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Check in: Amira Okafor' }));
    expect(await screen.findByText('Amira Okafor is checked in and in the queue.')).toBeVisible();
    const post = seen.find((s) => s.method === 'POST');
    expect(post?.headers.get('If-Match')).toBe('W/"3"');
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers.get('X-Client-Release')).toBe('r1.000000000000');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Check in: Amira Okafor' })).toBeNull(),
    );
  });

  it('explains a stale version (412) and refreshes the list instead of retrying', async () => {
    const user = userEvent.setup();
    let lists = 0;
    mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) {
        lists += 1;
        return json(200, { items: [arrival()], nextCursor: null });
      }
      if (r.path.endsWith('/check-in'))
        return json(412, { code: 'kernel.precondition_failed', requestId: 'req-1' });
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Check in: Amira Okafor' }));
    expect(await screen.findByText(/Someone changed this while you were editing/)).toBeVisible();
    await waitFor(() => expect(lists).toBe(2));
  });

  it('shows the daily QR code for the location and its text fallback', async () => {
    const user = userEvent.setup();
    mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === `/api/v1/locations/${LOC}/check-in-qr`)
        return json(200, { token: 'A1b2C3d4E5f6G7h8I9j0K_', localDate: '2031-06-10' });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Check in' }));
    await user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    expect(await screen.findByRole('img', { name: "Today's check-in QR code" })).toBeVisible();
    expect(screen.getByText('A1b2C3d4E5f6G7h8I9j0K_')).toBeVisible();
    expect(screen.getByText(/Valid for 2031-06-10/)).toBeVisible();
  });

  it("finds a patient by search and offers check-in for today's visit only", async () => {
    const user = userEvent.setup();
    const { seen } = mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals'))
        return json(200, {
          items: [
            arrival(),
            arrival({ reservationId: 'x', patientId: PAT2, patientName: 'Other Person' }),
          ],
          nextCursor: null,
        });
      if (r.path === '/api/v1/patients/search')
        return json(200, {
          items: [
            {
              id: PAT,
              mrn: 'MRN-0000123',
              givenName: 'Amira',
              familyName: 'Okafor',
              dateOfBirth: '1984-03-27',
              status: 'active',
            },
          ],
          nextCursor: null,
        });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Check in' }));
    await user.type(await screen.findByLabelText('Name'), 'Okafor');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('button', { name: /Show visits: Amira Okafor/ }));
    expect(await screen.findByText(/Visits today: Amira Okafor/)).toBeVisible();
    expect(screen.queryByText('Other Person')).toBeNull();
    expect(seen.find((s) => s.path === '/api/v1/patients/search')?.body).toEqual({
      name: 'Okafor',
    });
  });

  it('asks for at least one search field and does not call the API', async () => {
    const user = userEvent.setup();
    const { seen } = mount(FRONT_DESK, '/arrivals', (r) =>
      r.path.endsWith('/arrivals') ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    await user.click(await screen.findByRole('tab', { name: 'Check in' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fill in at least one');
    expect(seen.some((s) => s.path === '/api/v1/patients/search')).toBe(false);
  });
});

describe('queue (waiting time and stage)', () => {
  it('shows the wait in minutes and moves a stage with If-Match', async () => {
    const user = userEvent.setup();
    const entry = {
      id: RES,
      patientId: PAT,
      patientName: 'Amira Okafor',
      stage: 'waiting',
      triageCategory: null,
      enteredAt: '2031-06-10T09:00:00.000Z',
      stageChangedAt: '2031-06-10T09:00:00.000Z',
      waitSeconds: 754,
      assignedClinicianId: null,
      roomId: null,
      version: 2,
    };
    const { seen } = mount(NURSE, '/triage', (r) => {
      if (r.path.endsWith('/queue')) return json(200, { items: [entry], nextCursor: null });
      if (r.path === `/api/v1/queue-entries/${RES}/stage`)
        return json(200, { ...entry, stage: 'vitals', version: 3 });
      return undefined;
    });
    const table = await screen.findByRole('table', { name: 'Queue' });
    expect(within(table).getByText('12 min')).toBeVisible();
    await user.selectOptions(within(table).getByLabelText('Move to'), 'vitals');
    await user.click(within(table).getByRole('button', { name: 'Move: Amira Okafor' }));
    expect(await screen.findByText('Amira Okafor moved to Vitals.')).toBeVisible();
    const put = seen.find((s) => s.method === 'PUT');
    expect(put?.headers.get('If-Match')).toBe('W/"2"');
    expect(put?.body).toEqual({ stage: 'vitals' });
  });
});

describe('triage with vitals and the red-flag bar (PC-04, PC-06)', () => {
  const banner = (allergies: unknown) => ({
    patientId: PAT,
    displayName: 'Amira Okafor',
    dateOfBirth: '1984-03-27',
    mrn: 'MRN-0000123',
    allergies,
  });
  const vital = (over: Record<string, unknown>) => ({
    vitalId: 'v1',
    loincCode: '8867-4',
    value: 130,
    unit: '/min',
    measuredAt: '2031-06-10T09:05:00.000Z',
    rangeStatus: 'out_of_range',
    rangeLow: 50,
    rangeHigh: 110,
    correctsId: null,
    enteredInError: false,
    ...over,
  });

  function triageHandler(
    extra: Handler = () => undefined,
    allergies: unknown = {
      state: 'recorded',
      items: [
        {
          allergyId: 'a1',
          display: 'Penicillin',
          category: 'drug',
          severity: 'severe',
          coded: true,
        },
      ],
      moreCount: 0,
      uncodedCount: 0,
      lastChangedAt: null,
    },
  ): Handler {
    return (r) => {
      const x = extra(r);
      if (x !== undefined) return x;
      if (r.path === `/api/v1/patients/${PAT}/banner`) return json(200, banner(allergies));
      if (r.path === `/api/v1/check-ins/${RES}/triage` && r.method === 'GET')
        return json(200, { triage: null }, { ETag: 'W/"0"' });
      return undefined;
    };
  }
  const open = () =>
    selection.set({
      ...arrival({ checkedInAt: '2031-06-10T09:01:00.000Z' }),
      status: 'checked_in',
    } as never);

  it('shows out-of-range vitals in words with the stored range, never blocking the save', async () => {
    const user = userEvent.setup();
    open();
    const { seen } = mount(
      NURSE,
      '/triage',
      triageHandler((r) => {
        if (r.path === `/api/v1/check-ins/${RES}/vitals`)
          return json(201, {
            vitals: [
              vital({}),
              vital({
                vitalId: 'v2',
                loincCode: '2708-6',
                value: 97,
                unit: '%',
                rangeStatus: 'no_range',
                rangeLow: null,
                rangeHigh: null,
              }),
            ],
            outOfRange: ['8867-4'],
            patientBanner: banner(null),
          });
        return undefined;
      }),
    );
    await user.type(await screen.findByLabelText(/Heart rate/), '130');
    await user.type(screen.getByLabelText(/Oxygen saturation/), '97');
    await user.click(screen.getByRole('button', { name: 'Save vitals' }));
    const list = await screen.findByRole('list', { name: 'Recorded vitals' });
    expect(within(list).getByText('Out of range')).toBeVisible();
    expect(within(list).getByText('Range 50-110 /min')).toBeVisible();
    expect(within(list).getByText('No reference range set')).toBeVisible();
    const post = seen.find((s) => s.path.endsWith('/vitals'));
    expect(
      (post?.body as { vitals: { loincCode: string; value: number; unit: string }[] }).vitals.map(
        (v) => [v.loincCode, v.value, v.unit],
      ),
    ).toEqual([
      ['8867-4', 130, '/min'],
      ['2708-6', 97, '%'],
    ]);
    expect(post?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(screen.getByText('Vitals saved.')).toBeVisible();
  });

  it('rejects a non-number inline and sends nothing', async () => {
    const user = userEvent.setup();
    open();
    const { seen } = mount(NURSE, '/triage', triageHandler());
    await user.type(await screen.findByLabelText(/Heart rate/), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save vitals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Heart rate: enter a number.');
    expect(seen.some((s) => s.path.endsWith('/vitals'))).toBe(false);
  });

  it('raises the red-flag bar with the fixed text and no control after a triage that raised a flag', async () => {
    const user = userEvent.setup();
    open();
    const { seen } = mount(
      NURSE,
      '/triage',
      triageHandler((r) => {
        if (r.path === `/api/v1/check-ins/${RES}/triage` && r.method === 'POST')
          return json(
            201,
            {
              category: 'emergency',
              redFlag: true,
              alertId: 'al-1',
              advice: 'Call emergency services.',
              triage: {
                id: 't1',
                checkInId: RES,
                patientId: PAT,
                category: 'emergency',
                symptoms: null,
                notes: null,
                redFlag: true,
                alertId: 'al-1',
                byPrincipalId: 'p',
                assessedAt: '2031-06-10T09:06:00.000Z',
                supersedesId: null,
              },
              patientBanner: banner(null),
            },
            { ETag: 'W/"1"' },
          );
        return undefined;
      }),
    );
    await user.selectOptions(await screen.findByLabelText('Triage category'), 'emergency');
    await user.click(screen.getByRole('button', { name: 'Save triage' }));
    const text = await screen.findByText('Red flag raised. The on-duty doctor has been alerted.');
    const barEl = text.closest('[data-alert-state]') as HTMLElement;
    expect(barEl).toHaveAttribute('data-alert-state', 'raised');
    // UXR-08 option B: a status, not an action - no Dismiss, no doctor name, no countdown, no acknowledged state.
    expect(within(barEl).queryAllByRole('button')).toHaveLength(0);
    expect(barEl.textContent).not.toMatch(/dismiss|close|escalat|acknowledg|Dr\./i);
    expect(screen.getByText('Call emergency services.')).toBeVisible();
    const post = seen.find((s) => s.path.endsWith('/triage') && s.method === 'POST');
    expect(post?.body).toEqual({ category: 'emergency' });
    expect(post?.headers.get('If-Match')).toBeNull(); // first assessment
  });

  it('re-triage sends the current assessment count as If-Match', async () => {
    const user = userEvent.setup();
    open();
    const triage = {
      id: 't1',
      category: 'standard',
      notes: null,
      redFlag: false,
      alertId: null,
      assessedAt: '2031-06-10T09:06:00.000Z',
      patientId: PAT,
    };
    const { seen } = mount(NURSE, '/triage', (r) => {
      if (r.path === `/api/v1/check-ins/${RES}/triage` && r.method === 'GET')
        return json(200, { triage, patientBanner: banner(null) }, { ETag: 'W/"1"' });
      if (r.path === `/api/v1/check-ins/${RES}/triage` && r.method === 'POST')
        return json(
          201,
          {
            category: 'urgent',
            redFlag: false,
            triage: { ...triage, id: 't2', category: 'urgent' },
            patientBanner: banner(null),
          },
          { ETag: 'W/"2"' },
        );
      if (r.path.endsWith('/banner')) return json(200, banner(null));
      return undefined;
    });
    expect(await screen.findByText('Current assessment: Standard')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Triage category'), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Save triage' }));
    await screen.findByText('Triage saved.');
    expect(seen.find((s) => s.method === 'POST')?.headers.get('If-Match')).toBe('W/"1"');
    expect(screen.queryByText('Red flag raised. The on-duty doctor has been alerted.')).toBeNull();
  });

  it('says so when offline and disables the clinical writes', async () => {
    open();
    mount(NURSE, '/triage', triageHandler());
    const save = await screen.findByRole('button', { name: 'Save vitals' });
    expect(save).toBeEnabled();
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/You are offline/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save vitals' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save triage' })).toBeDisabled();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('button', { name: 'Save vitals' })).toBeEnabled();
  });

  it('draws the allergy block in all three states: recorded, none recorded, not shown', async () => {
    open();
    mount(NURSE, '/triage', triageHandler());
    expect(await screen.findByText(/Penicillin/)).toBeVisible();
    cleanup();
    mount(
      NURSE,
      '/triage',
      triageHandler(undefined, {
        state: 'none_recorded',
        items: [],
        moreCount: 0,
        uncodedCount: 0,
        lastChangedAt: null,
      }),
    );
    expect(await screen.findByText('No allergies recorded')).toBeVisible();
    cleanup();
    mount(NURSE, '/triage', triageHandler(undefined, null));
    await waitFor(() =>
      expect(document.querySelector('[data-allergy-state="not-shown"]')).not.toBeNull(),
    );
    expect(screen.queryByText('No allergies recorded')).toBeNull();
  });
});

describe('forms review (PC-03)', () => {
  it('shows each item as to do or done, a withdrawn consent, and a permission note for a part the role cannot read', async () => {
    selection.set({
      ...arrival({
        checkedInAt: '2031-06-10T09:01:00.000Z',
        previsit: { questionnaire: true, consents: false, insurance: false },
      }),
    } as never);
    mount(['patient.read'], '/forms', (r) => {
      if (r.path === `/api/v1/patients/${PAT}/consents`)
        return json(200, {
          items: [
            {
              id: 'c1',
              patientId: PAT,
              templateKey: 'telehealth',
              templateVersion: 2,
              status: 'pending',
              signedAt: null,
            },
            {
              id: 'c2',
              patientId: PAT,
              templateKey: 'privacy',
              templateVersion: 1,
              status: 'signed',
              signedAt: '2031-06-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      if (r.path.endsWith('/questionnaire-responses')) return json(403, { code: 'auth.forbidden' });
      return undefined;
    });
    expect(await screen.findByText('telehealth v2')).toBeVisible();
    expect(screen.getByText('Not signed')).toBeVisible();
    expect(screen.getByText('Signed')).toBeVisible();
    expect(await screen.findByText(/Showing .*pre-visit items.* only/i)).toBeVisible();
    expect(screen.getAllByText('To do').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Done')).toBeVisible();
  });
});

describe('registration and the duplicate warning (7.3)', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(await screen.findByLabelText('Given name'), 'Amira');
    await user.type(screen.getByLabelText('Family name'), 'Okafor');
    await user.type(screen.getByLabelText('Date of birth'), '1984-03-27');
    await user.type(screen.getByLabelText('State'), 'ny');
  };
  const candidates = {
    matchCheckId: 'mc-1',
    candidates: [
      {
        candidateRef: 'r1',
        strength: 'exact',
        matchedFields: ['familyName', 'dateOfBirth'],
        inScope: true,
        display: {
          patientId: PAT,
          mrn: 'MRN-0000123',
          givenName: 'Amira',
          familyName: 'Okafor',
          dateOfBirth: '1984-03-27',
        },
      },
      {
        candidateRef: 'r2',
        strength: 'probable',
        matchedFields: ['phone'],
        inScope: false,
        display: {
          patientId: PAT2,
          mrn: 'MRN-0000999',
          givenName: 'Leaky',
          familyName: 'Name',
          dateOfBirth: '1990-01-01',
        },
      },
    ],
  };

  it('warns with the agreed words, never shows an out-of-scope record, and requires a reason to create anyway', async () => {
    const user = userEvent.setup();
    const { seen } = mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === '/api/v1/patients/match') return json(200, candidates);
      if (r.path === '/api/v1/patients' && r.method === 'POST')
        return json(201, { patientId: PAT2, mrn: 'MRN-0000777', duplicateFlags: 1 });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Register a patient' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Check for an existing record' }));
    expect(
      await screen.findByText('A record may already exist. Check before creating a new one.'),
    ).toBeVisible();
    expect(screen.getByText(/Exact match/)).toBeVisible();
    expect(
      screen.getByText('A matching record exists outside your locations. Details are not shown.'),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('Leaky');
    expect(document.body.textContent).not.toContain('MRN-0000999');
    expect(screen.getAllByRole('button', { name: 'Open existing record' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Create anyway (reason required)' }));
    await user.click(screen.getByRole('button', { name: 'Create the new record' }));
    // Once in the summary that takes focus, once under the field (UI-UX 6, validation).
    expect((await screen.findAllByText('Enter why this is a different person.')).length).toBe(2);
    expect(seen.some((s) => s.method === 'POST' && s.path === '/api/v1/patients')).toBe(false);

    await user.type(
      screen.getByLabelText('Why is this a different person?'),
      'Different date of birth on the card',
    );
    await user.click(screen.getByRole('button', { name: 'Create the new record' }));
    expect(await screen.findByText(/Patient registered. MRN MRN-0000777./)).toBeVisible();
    expect(screen.getByText('The new record is flagged for review.')).toBeVisible();
    const reg = seen.find((s) => s.method === 'POST' && s.path === '/api/v1/patients');
    expect(reg?.body).toMatchObject({
      matchCheckId: 'mc-1',
      duplicateAcknowledged: true,
      acknowledgeReason: 'Different date of birth on the card',
      stateCode: 'NY',
      locationId: LOC,
    });
    expect(reg?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('registers straight away when nothing matches, using the check ID', async () => {
    const user = userEvent.setup();
    const { seen } = mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === '/api/v1/patients/match')
        return json(200, { matchCheckId: 'mc-2', candidates: [] });
      if (r.path === '/api/v1/patients' && r.method === 'POST')
        return json(201, { patientId: PAT, mrn: 'MRN-0000001', duplicateFlags: 0 });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Register a patient' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Check for an existing record' }));
    await user.click(await screen.findByRole('button', { name: 'Register patient' }));
    expect(await screen.findByText('Patient registered. MRN MRN-0000001.')).toBeVisible();
    expect(
      seen.find((s) => s.method === 'POST' && s.path === '/api/v1/patients')?.body,
    ).toMatchObject({ matchCheckId: 'mc-2', duplicateAcknowledged: false });
  });

  it('invalidates the check when a field changes after it', async () => {
    const user = userEvent.setup();
    mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === '/api/v1/patients/match')
        return json(200, { matchCheckId: 'mc-2', candidates: [] });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Register a patient' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Check for an existing record' }));
    await screen.findByRole('button', { name: 'Register patient' });
    await user.type(screen.getByLabelText('Phone'), '5');
    expect(screen.queryByRole('button', { name: 'Register patient' })).toBeNull();
  });
});

describe('merge request and approval (7.3, 8)', () => {
  it('does not offer merge, or the merge tab, to a user without either merge permission', async () => {
    mount(FRONT_DESK, '/arrivals', (r) =>
      r.path.endsWith('/arrivals') ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    await screen.findByRole('tab', { name: 'Arrivals board' });
    expect(screen.queryByRole('tab', { name: 'Merge' })).toBeNull();
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
  });

  it('hides "Request a merge" from the duplicate queue without patient.merge.request', async () => {
    const user = userEvent.setup();
    mount(FRONT_DESK, '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === '/api/v1/duplicate-flags')
        return json(200, {
          items: [
            {
              id: 'f1',
              patientId: PAT,
              candidatePatientId: PAT2,
              strength: 'exact',
              source: 'front_desk',
              status: 'open',
              createdAt: '2031-06-09T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Possible duplicates' }));
    expect(await screen.findByText('Exact')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request a merge' })).toBeNull();
  });

  it('requests a merge only after the survivor MRN is typed, and shows the reference', async () => {
    const user = userEvent.setup();
    const patient = (id: string, mrn: string, given: string) => ({
      id,
      mrn,
      givenName: given,
      familyName: 'Okafor',
      dateOfBirth: '1984-03-27',
      status: 'active',
    });
    const { seen } = mount([...FRONT_DESK, 'patient.merge.request'], '/arrivals', (r) => {
      if (r.path.endsWith('/arrivals')) return json(200, { items: [], nextCursor: null });
      if (r.path === '/api/v1/duplicate-flags')
        return json(200, {
          items: [
            {
              id: 'f1',
              patientId: PAT,
              candidatePatientId: PAT2,
              strength: 'exact',
              source: 'front_desk',
              status: 'open',
              createdAt: '2031-06-09T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      if (r.path === `/api/v1/patients/${PAT}`)
        return json(200, patient(PAT, 'MRN-0000123', 'Amira'));
      if (r.path === `/api/v1/patients/${PAT2}`)
        return json(200, patient(PAT2, 'MRN-0000124', 'Amyra'));
      if (r.path === '/api/v1/patient-merges' && r.method === 'POST')
        return json(200, { id: MERGE, status: 'requested' });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'Possible duplicates' }));
    await user.click(await screen.findByRole('button', { name: 'Request a merge' }));
    expect(await screen.findByText(/Amira Okafor · MRN-0000123/)).toBeVisible();
    expect(screen.getByText(/Amyra Okafor · MRN-0000124/)).toBeVisible();
    await user.type(
      screen.getByLabelText('Reason for the merge'),
      'Same person, two registrations',
    );
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect((await screen.findAllByText('The MRN does not match the record to keep.')).length).toBe(
      2,
    );
    expect(seen.some((s) => s.path === '/api/v1/patient-merges')).toBe(false);
    await user.type(screen.getByLabelText('MRN of the record to keep'), 'mrn-0000123');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(
      await screen.findByText('Merge request sent. A second staff member must approve it.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Reference to give to the approver')).toHaveValue(MERGE);
    expect(seen.find((s) => s.path === '/api/v1/patient-merges')?.body).toEqual({
      survivorId: PAT,
      mergedId: PAT2,
      reason: 'Same person, two registrations',
    });
  });

  it('lets an approver open a request, hides records they cannot see, and approves after a confirmation', async () => {
    const user = userEvent.setup();
    const { seen } = mount(['patient.merge.approve'], '/arrivals', (r) => {
      if (r.path === `/api/v1/patient-merges/${MERGE}/approve`)
        return json(200, {
          id: MERGE,
          status: 'approved',
          survivorId: null,
          mergedId: null,
          reason: 'x',
          createdAt: '',
          decidedAt: '2031-06-10T10:00:00.000Z',
          failureCode: null,
          counts: null,
        });
      if (r.path === `/api/v1/patient-merges/${MERGE}`)
        return json(200, {
          id: MERGE,
          status: 'requested',
          survivorId: null,
          mergedId: null,
          reason: null,
          createdAt: '2031-06-10T09:00:00.000Z',
          decidedAt: null,
          failureCode: null,
          counts: null,
        });
      return undefined;
    });
    await user.type(await screen.findByLabelText('Merge request reference'), MERGE);
    await user.click(screen.getByRole('button', { name: 'Open request' }));
    expect(await screen.findByText('Waiting for approval')).toBeVisible();
    expect(screen.getByText(/records are not shown to you/i)).toBeVisible();
    expect(screen.getByText(/reason is only shown to the person who requested/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Approve merge' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(seen.some((s) => s.path.endsWith('/approve'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Approve merge' }));
    await waitFor(() => expect(seen.some((s) => s.path.endsWith('/approve'))).toBe(true));
    expect(
      seen.find((s) => s.path.endsWith('/approve'))?.headers.get('Idempotency-Key'),
    ).toBeTruthy();
  });

  it('says so plainly when the server refuses a self-approval', async () => {
    const user = userEvent.setup();
    mount(['patient.merge.approve'], '/arrivals', (r) => {
      if (r.path.endsWith('/approve')) return json(403, { code: 'patient.merge_self_approval' });
      if (r.path === `/api/v1/patient-merges/${MERGE}`)
        return json(200, {
          id: MERGE,
          status: 'requested',
          survivorId: null,
          mergedId: null,
          reason: null,
          createdAt: '',
          decidedAt: null,
          failureCode: null,
          counts: null,
        });
      return undefined;
    });
    await user.type(await screen.findByLabelText('Merge request reference'), MERGE);
    await user.click(screen.getByRole('button', { name: 'Open request' }));
    await user.click(await screen.findByRole('button', { name: 'Approve merge' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve merge' }),
    );
    expect(await screen.findByText('You cannot approve a merge you requested.')).toBeVisible();
  });
});

describe('follow-ups and no-shows (PC-07, PC-08)', () => {
  it('lists open follow-ups due-first with overdue in words and closes one with If-Match', async () => {
    const user = userEvent.setup();
    const fu = {
      id: 'fu1',
      patientId: PAT,
      locationId: LOC,
      dueOn: '2020-01-01',
      reason: 'Call about lab visit',
      status: 'open',
      ownerPrincipalId: null,
      version: 5,
    };
    const { seen } = mount(FRONT_DESK, '/follow-ups', (r) => {
      if (r.path.endsWith('/follow-ups') && r.method === 'GET')
        return json(200, { items: [fu], nextCursor: null });
      if (r.path === '/api/v1/follow-ups/fu1')
        return json(200, { ...fu, status: 'done', version: 6 });
      return undefined;
    });
    expect(await screen.findByText('Overdue')).toBeVisible();
    expect(seen.find((s) => s.path.endsWith('/follow-ups'))?.path).toBe(
      `/api/v1/locations/${LOC}/follow-ups`,
    );
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Follow-up updated.')).toBeVisible();
    const patch = seen.find((s) => s.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('W/"5"');
    expect(patch?.body).toEqual({ status: 'done' });
  });

  it('lists missed visits and marks a past-grace visit as no-show', async () => {
    const user = userEvent.setup();
    const { seen } = mount(FRONT_DESK, '/follow-ups', (r) => {
      if (r.path.endsWith('/follow-ups')) return json(200, { items: [], nextCursor: null });
      if (r.path.endsWith('/arrivals'))
        return json(200, {
          items: [
            arrival({ noShowCandidate: true }),
            arrival({ reservationId: 'r9', status: 'completed' }),
          ],
          nextCursor: null,
        });
      if (r.path.endsWith('/no-show')) return json(200, {});
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'No-shows' }));
    expect(await screen.findByText('Past the grace period')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mark as no-show: Amira Okafor' }));
    expect(await screen.findByText('Marked as no-show.')).toBeVisible();
    expect(seen.find((s) => s.path.endsWith('/no-show'))?.headers.get('If-Match')).toBe('W/"3"');
  });

  it('shows the grace-period refusal in words', async () => {
    const user = userEvent.setup();
    mount(FRONT_DESK, '/follow-ups', (r) => {
      if (r.path.endsWith('/follow-ups')) return json(200, { items: [], nextCursor: null });
      if (r.path.endsWith('/arrivals'))
        return json(200, { items: [arrival({ noShowCandidate: true })], nextCursor: null });
      if (r.path.endsWith('/no-show')) return json(422, { code: 'scheduling.grace_not_elapsed' });
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'No-shows' }));
    await user.click(await screen.findByRole('button', { name: /Mark as no-show/ }));
    expect(await screen.findByText(/grace period for this visit has not passed/)).toBeVisible();
  });
});

describe('states', () => {
  it('shows the location notice when the account has no location', async () => {
    mount(FRONT_DESK, '/arrivals', () => undefined, [undefined]);
    expect(await screen.findByText(/not assigned to a location/)).toBeVisible();
  });

  it('shows the 403 page when no tab is permitted', async () => {
    mount(['patient.read'], '/arrivals', () => undefined);
    expect(await screen.findByText("You don't have access to this.")).toBeVisible();
  });

  it('shows a server error with a reference and a retry for a failed load', async () => {
    const user = userEvent.setup();
    let n = 0;
    mount(FRONT_DESK, '/arrivals', (r) => {
      if (!r.path.endsWith('/arrivals')) return undefined;
      n += 1;
      return n === 1
        ? json(500, { code: 'kernel.internal', requestId: 'req-77' })
        : json(200, { items: [], nextCursor: null });
    });
    expect(
      await screen.findByText('Something went wrong on our side. Your work is safe.'),
    ).toBeVisible();
    expect(screen.getByText('req-77')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No visits are booked at this location today.')).toBeVisible();
  });

  it('shows the empty arrivals board in words', async () => {
    mount(FRONT_DESK, '/arrivals', (r) =>
      r.path.endsWith('/arrivals') ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    expect(await screen.findByText('No visits are booked at this location today.')).toBeVisible();
  });

  it('lets a user with two locations choose between them', async () => {
    const user = userEvent.setup();
    const L2 = '66666666-6666-4666-8666-666666666666';
    const { seen } = mount(
      FRONT_DESK,
      '/arrivals',
      (r) =>
        r.path.endsWith('/arrivals') ? json(200, { items: [], nextCursor: null }) : undefined,
      [LOC, L2],
    );
    await user.selectOptions(await screen.findByLabelText('Location'), L2);
    await waitFor(() =>
      expect(seen.some((s) => s.path === `/api/v1/locations/${L2}/arrivals`)).toBe(true),
    );
  });
});
