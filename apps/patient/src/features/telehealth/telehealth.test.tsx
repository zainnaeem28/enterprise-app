// CONTRACT MOCK: no real API, database, video vendor or device runs here. TC-TH-01..05 need the video sandbox and stay BLOCKED
// (C-10, C-11); these tests prove only what this page does with the answers the contract describes.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, runtimeWith } from '../../app/test-helpers.js';
import { createTelehealthApi } from './api.js';
import { JoinPage } from './JoinPage.js';
import { isTelehealthPath, matchTelehealthRoute } from './routes.js';
import { zoneLabels } from './time.js';
import type { DeviceCheck } from './types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RES = '33333333-3333-4333-8333-333333333333';
const BASE = `/api/v1/appointments/${RES}/video-session`;
const STARTS = '2031-06-02T13:30:00.000Z'; // 9:30 AM in New York
const view = (over: Record<string, unknown> = {}) => ({
  status: 'open',
  admission: 'waiting',
  joinOpensAt: '2031-06-02T13:20:00.000Z',
  needsLocationConfirmation: true,
  startsAt: STARTS,
  endsAt: '2031-06-02T14:00:00.000Z',
  clinicTimeZone: 'America/New_York',
  clinicLocalStart: '2031-06-02T09:30:00',
  ...over,
});
const NOW = new Date('2031-06-02T13:25:00.000Z').getTime();

interface Seen {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}
function setup(
  routes: Record<string, (s: Seen) => Response> = {},
  props: Partial<Parameters<typeof JoinPage>[0]> = {},
) {
  const seen: Seen[] = [];
  const h = runtimeWith(async (request) => {
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    const s: Seen = {
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : JSON.parse(text),
      headers: request.headers,
    };
    seen.push(s);
    const r = routes[`${request.method} ${url.pathname}`];
    if (r !== undefined) return r(s);
    if (request.method === 'GET' && url.pathname === BASE) return json(200, view());
    if (request.method === 'POST' && url.pathname === `${BASE}/location`)
      return json(200, { result: 'allowed', flagged: false });
    return json(404, { status: 404, code: 'kernel.not_found', requestId: 'r-1' });
  });
  const pass: DeviceCheck = { camera: 'pass', mic: 'pass', bandwidth: 'pass' };
  const utils = render(
    <JoinPage
      api={createTelehealthApi(h.runtime)}
      reservationId={RES}
      probe={async () => pass}
      viewer="America/Los_Angeles"
      now={() => NOW}
      pollMs={20}
      {...props}
    />,
  );
  return { seen, ...utils };
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const confirm = async () => {
  fireEvent.change(await screen.findByLabelText('The state you are in right now'), {
    target: { value: 'NY' },
  });
  click('Confirm my location');
  await screen.findByText(/You said you are in/);
};

describe('routes and time', () => {
  it('matches the video route by reservation id only', () => {
    expect(matchTelehealthRoute(`/appointments/${RES}/video`)).toEqual({
      name: 'join',
      reservationId: RES,
    });
    expect(isTelehealthPath(`/appointments/${RES}/previsit`)).toBe(false);
  });
  it('gives two labels when the zones differ and one when they read the same', () => {
    const two = zoneLabels(STARTS, 'America/New_York', 'America/Los_Angeles');
    expect(two.clinic).toContain('9:30');
    expect(two.mine).toContain('6:30');
    expect(zoneLabels(STARTS, 'America/New_York', 'America/New_York').mine).toBeUndefined();
  });
});

describe('PP-23 device check and join', () => {
  it('shows both time zones when they differ', async () => {
    setup();
    expect(await screen.findByText('Clinic time')).toBeInTheDocument();
    expect(screen.getByText('Your time')).toBeInTheDocument();
    cleanup();
    setup({}, { viewer: 'America/New_York' });
    await screen.findByText('Clinic time');
    expect(screen.queryByText('Your time')).not.toBeInTheDocument();
  });

  it('sends exactly camera, mic and bandwidth and shows each as words', async () => {
    const m = setup(
      { [`POST ${BASE}/device-check`]: () => json(200, {}) },
      {
        probe: async () => ({ camera: 'pass', mic: 'fail', bandwidth: 'pass' }),
      },
    );
    await screen.findByText('Clinic time');
    click('Check my devices');
    expect(await screen.findByText('Not working')).toBeInTheDocument();
    expect(screen.getAllByText('Working')).toHaveLength(2);
    expect(screen.getByText('Something is not working')).toBeInTheDocument();
    expect(m.seen.find((s) => s.path === `${BASE}/device-check`)?.body).toEqual({
      camera: 'pass',
      mic: 'fail',
      bandwidth: 'pass',
    });
  });

  it('will not join before the location is confirmed, and does not join before the window opens', async () => {
    const m = setup();
    await screen.findByText('Clinic time');
    expect(screen.getByRole('button', { name: 'Join the visit' })).toBeDisabled();
    await confirm();
    expect(screen.getByRole('button', { name: 'Join the visit' })).toBeEnabled();
    expect(m.seen.find((s) => s.path === `${BASE}/location`)?.body).toEqual({ state: 'NY' });
    cleanup();
    setup({ [`GET ${BASE}`]: () => json(200, view({ joinOpensAt: '2031-06-02T13:40:00.000Z' })) });
    expect(await screen.findByText('Joining opens soon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join the visit' })).toBeDisabled();
  });

  it('asks for a state before sending the location, and a licensing refusal offers no way around it', async () => {
    const m = setup({
      [`POST ${BASE}/location`]: () =>
        json(422, { status: 422, code: 'telehealth.licensing_refused', requestId: 'r-2' }),
    });
    await screen.findByText('Clinic time');
    click('Confirm my location');
    expect(await screen.findByText('Choose the state you are in right now')).toBeInTheDocument();
    expect(m.seen.some((s) => s.path === `${BASE}/location`)).toBe(false);
    fireEvent.change(screen.getByLabelText('The state you are in right now'), {
      target: { value: 'CA' },
    });
    click('Confirm my location');
    expect(
      await screen.findByText('This visit cannot go ahead by video from there'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join the visit' })).toBeDisabled();
    expect(screen.queryByText(/override|anyway/i)).not.toBeInTheDocument();
  });

  it('waits in the waiting room, then hands the credential to the video client once admitted, and never shows it', async () => {
    let admitted = false;
    const grants: unknown[] = [];
    const m = setup(
      {
        [`GET ${BASE}`]: () =>
          json(
            200,
            view({
              admission: admitted ? 'admitted' : 'waiting',
              needsLocationConfirmation: false,
            }),
          ),
        [`POST ${BASE}/join`]: () =>
          admitted
            ? json(200, { vendor: 'stub', meetingId: 'm-1', attendeeToken: 'SECRET-TOKEN-VALUE' })
            : json(409, { status: 409, code: 'telehealth.not_admitted', requestId: 'r-3' }),
      },
      { onGrant: (g) => grants.push(g) },
    );
    await screen.findByText('Clinic time');
    click('Join the visit');
    expect(await screen.findByText('You are in the waiting room')).toBeInTheDocument();
    expect(grants).toHaveLength(0);
    admitted = true;
    await waitFor(() => expect(grants).toHaveLength(1));
    expect(grants[0]).toEqual({
      vendor: 'stub',
      meetingId: 'm-1',
      attendeeToken: 'SECRET-TOKEN-VALUE',
    });
    expect(document.body.textContent).not.toContain('SECRET-TOKEN-VALUE');
    expect(
      m.seen.filter((s) => s.path === `${BASE}/join`)[0]?.headers.get('idempotency-key'),
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says the video app is not connected when no handler is given, instead of pretending to join', async () => {
    setup({
      [`GET ${BASE}`]: () =>
        json(200, view({ admission: 'admitted', needsLocationConfirmation: false })),
      [`POST ${BASE}/join`]: () =>
        json(200, { vendor: 'stub', meetingId: 'm-1', attendeeToken: 'T' }),
    });
    await screen.findByText('Clinic time');
    click('Join the visit');
    expect(await screen.findByText('The video app is not connected yet')).toBeInTheDocument();
  });

  it('a join the server answers with location_required goes back to the confirmation step', async () => {
    setup({
      [`GET ${BASE}`]: () => json(200, view({ needsLocationConfirmation: false })),
      [`POST ${BASE}/join`]: () =>
        json(409, { status: 409, code: 'telehealth.location_required', requestId: 'r-4' }),
    });
    await screen.findByText('Clinic time');
    click('Join the visit');
    expect(
      await screen.findByText('Please confirm where you are before you join.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join the visit' })).toBeDisabled();
  });

  it('a 404 on the session is the same message as nothing there', async () => {
    setup({
      [`GET ${BASE}`]: () => json(404, { status: 404, code: 'kernel.not_found', requestId: 'r-5' }),
    });
    expect(await screen.findByText(/can.t find this/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = setup();
    await screen.findByText('Clinic time');
    const r = await axe.run(container, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
    await act(async () => undefined);
  });

  it('F01: leaves the waiting room and stops polling when the host removes the patient', async () => {
    let status = 'waiting';
    const m = setup(
      {
        [`GET ${BASE}`]: () =>
          json(200, view({ admission: status, needsLocationConfirmation: false })),
        [`POST ${BASE}/join`]: () =>
          json(409, { status: 409, code: 'telehealth.not_admitted', requestId: 'r-3' }),
      },
      {},
    );
    await screen.findByText('Clinic time');
    click('Join the visit');
    expect(await screen.findByText('You are in the waiting room')).toBeInTheDocument();
    status = 'removed';
    expect(await screen.findByText('You were removed from the waiting room')).toBeInTheDocument();
    expect(screen.queryByText('You are in the waiting room')).not.toBeInTheDocument();
    const polls = m.seen.filter((x) => x.method === 'GET').length;
    await new Promise((r) => setTimeout(r, 120));
    expect(m.seen.filter((x) => x.method === 'GET').length).toBe(polls);
  });

  it('F01: stops polling when the session ends while waiting', async () => {
    let status = 'open';
    const m = setup(
      {
        [`GET ${BASE}`]: () => json(200, view({ status, needsLocationConfirmation: false })),
        [`POST ${BASE}/join`]: () =>
          json(409, { status: 409, code: 'telehealth.not_admitted', requestId: 'r-3' }),
      },
      {},
    );
    await screen.findByText('Clinic time');
    click('Join the visit');
    await screen.findByText('You are in the waiting room');
    status = 'ended';
    expect(await screen.findByText('This video visit is over')).toBeInTheDocument();
    const polls = m.seen.filter((x) => x.method === 'GET').length;
    await new Promise((r) => setTimeout(r, 120));
    expect(m.seen.filter((x) => x.method === 'GET').length).toBe(polls);
  });

  it('F02: opens Join by itself when the join window opens', async () => {
    const opens = new Date(view().joinOpensAt).getTime();
    const start = Date.now();
    setup({}, { now: () => opens - 300 + (Date.now() - start), pollMs: 100000 });
    expect(await screen.findByText('Joining opens soon')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Joining opens soon')).not.toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it('F05: clears the "one more step" note once the location is confirmed', async () => {
    setup({
      [`POST ${BASE}/join`]: () =>
        json(409, { status: 409, code: 'telehealth.location_required', requestId: 'r-4' }),
    });
    await screen.findByText('Clinic time');
    await confirm();
    click('Join the visit');
    await screen.findByText('One more step');
    await confirm();
    expect(screen.queryByText('One more step')).not.toBeInTheDocument();
  });
});
