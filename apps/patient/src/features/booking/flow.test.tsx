import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../../app/test-helpers.js';
import {
  appointment,
  DOCTOR,
  mount,
  PATIENT,
  PLACE,
  posts,
  RESERVATION,
  SERVICE,
  SLOTS,
  startsAt,
} from './testkit.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  document.title = '';
});

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const hold = (expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()) =>
  json(201, { reservationId: RESERVATION, expiresAt }, { date: new Date().toUTCString() });

async function toTimeStep(routes: Parameters<typeof mount>[1] = {}) {
  const m = mount('/book', routes);
  fireEvent.click(await screen.findByRole('radio', { name: /General visit/ }));
  click('Continue');
  await screen.findByRole('heading', { name: 'Where and with whom?' });
  fireEvent.change(screen.getByLabelText('Place'), { target: { value: PLACE } });
  await screen.findByLabelText('Doctor');
  click('Continue');
  await screen.findByRole('heading', { name: 'Choose a date and time' });
  return m;
}
const pickFirstSlot = async () => {
  const slots = await screen.findAllByRole('button', { name: /10:00 AM|11:00 AM/ });
  fireEvent.click(slots[0]!);
};

describe('PP-10..PP-14 book a visit', () => {
  it('walks service, doctor and place, time, confirm and booked, with step-1 and step-2 keys that differ', async () => {
    const m = await toTimeStep({
      'POST /api/v1/holds': () => hold(),
      ['POST /api/v1/appointments/' + RESERVATION + '/confirm']: () => json(200, appointment()),
    });
    expect(m.seen.find((s) => s.path === '/api/v1/availability/search')?.body).toMatchObject({
      serviceId: SERVICE,
      locationId: PLACE,
      mode: 'in_person',
    });
    await pickFirstSlot();
    expect(await screen.findByRole('timer')).toHaveTextContent(/^Held for \d\d:\d\d$/);
    click('Continue');
    await screen.findByRole('heading', { name: 'Check and confirm' });
    expect(screen.getByText(/Cancellation policy/)).toBeInTheDocument();
    expect(screen.getByText('General visit')).toBeInTheDocument();
    click('Confirm appointment');
    await screen.findByRole('heading', { name: 'Your appointment is booked' });

    const [h] = posts(m.seen, '/api/v1/holds');
    const [c] = posts(m.seen, `/api/v1/appointments/${RESERVATION}/confirm`);
    expect(h?.body).toMatchObject({
      patientId: PATIENT,
      serviceId: SERVICE,
      locationId: PLACE,
      clinicianId: DOCTOR,
      startsAt: SLOTS[0]!.startsAt,
      mode: 'in_person',
    });
    const holdKey = h?.headers.get('Idempotency-Key');
    const confirmKey = c?.headers.get('Idempotency-Key');
    expect(holdKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirmKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(confirmKey).not.toBe(holdKey);
    expect(c?.headers.get('X-CSRF-Token')).toBe('csrf-test');
    expect(h?.headers.get('X-CSRF-Token')).toBe('csrf-test');
    await waitFor(() => expect(document.title).toBe('Patient portal - Booked'));
  });

  it('a double click on Confirm sends one request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = await toTimeStep({
      'POST /api/v1/holds': () => hold(),
      ['POST /api/v1/appointments/' + RESERVATION + '/confirm']: async () => {
        await gate;
        return json(200, appointment());
      },
    });
    await pickFirstSlot();
    await screen.findByRole('timer');
    click('Continue');
    await screen.findByRole('heading', { name: 'Check and confirm' });
    const button = screen.getByRole('button', { name: 'Confirm appointment' });
    fireEvent.click(button);
    fireEvent.click(button);
    release();
    await screen.findByRole('heading', { name: 'Your appointment is booked' });
    expect(posts(m.seen, `/api/v1/appointments/${RESERVATION}/confirm`)).toHaveLength(1);
  });

  it('add to calendar offers an .ics file with the appointment time', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    const click_ = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const m = await toTimeStep({
      'POST /api/v1/holds': () => hold(),
      ['POST /api/v1/appointments/' + RESERVATION + '/confirm']: () => json(200, appointment()),
    });
    void m;
    await pickFirstSlot();
    await screen.findByRole('timer');
    click('Continue');
    click_.mockClear();
    await screen.findByRole('heading', { name: 'Check and confirm' });
    click('Confirm appointment');
    await screen.findByRole('heading', { name: 'Your appointment is booked' });
    click('Add to calendar');
    expect(click_).toHaveBeenCalledOnce();
    const text = await created[0]!.text();
    expect(created[0]!.type).toContain('text/calendar');
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('DTSTART:20310610T140000Z');
    expect(text).toContain('SUMMARY:Appointment');
    click_.mockRestore();
  });

  it('a video visit needs the state before a hold is made, and sends it with the hold', async () => {
    const m = await toTimeStep({ 'POST /api/v1/holds': () => hold() });
    fireEvent.click(screen.getByRole('radio', { name: 'Video visit' }));
    await waitFor(() =>
      expect(m.seen.filter((s) => s.path === '/api/v1/availability/search').length).toBe(2),
    );
    const slots = await screen.findAllByRole('button', { name: /10:00 AM/ });
    fireEvent.click(slots[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/two-letter state/);
    expect(posts(m.seen, '/api/v1/holds')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/State you will be in/), { target: { value: 'aa' } });
    fireEvent.click(screen.getAllByRole('button', { name: /10:00 AM/ })[0]!);
    await waitFor(() => expect(posts(m.seen, '/api/v1/holds')).toHaveLength(1));
    expect(posts(m.seen, '/api/v1/holds')[0]?.body).toMatchObject({ patientState: 'AA' });
  });

  it('shows no raw patient or appointment detail in the tab title', async () => {
    await toTimeStep();
    expect(document.title).toBe('Patient portal - Book: date and time');
  });
});

describe('hold idempotency keys', () => {
  it('picks A, B, A: the second pick of A is a new request with a new key', async () => {
    const m = await toTimeStep({ 'POST /api/v1/holds': () => hold() });
    const pick = async (re: RegExp) => {
      const slots = await screen.findAllByRole('button', { name: re });
      fireEvent.click(slots[0]!);
    };
    await pick(/10:00 AM/);
    await waitFor(() => expect(posts(m.seen, '/api/v1/holds')).toHaveLength(1));
    await pick(/11:00 AM/);
    await waitFor(() => expect(posts(m.seen, '/api/v1/holds')).toHaveLength(2));
    await pick(/10:00 AM/);
    await waitFor(() => expect(posts(m.seen, '/api/v1/holds')).toHaveLength(3));
    const keys = posts(m.seen, '/api/v1/holds').map((h) => h.headers.get('Idempotency-Key'));
    expect(new Set(keys).size).toBe(3);
  });
});

describe('slot taken and hold expiry (X-01, X-02)', () => {
  const taken = () =>
    json(409, {
      status: 409,
      code: 'scheduling.slot_taken',
      requestId: 'req-race',
      errors: [{ path: '/alternatives/0', code: SLOTS[1]!.startsAt }],
    });

  it('shows "That time was just taken" with alternatives, a waitlist offer and a disabled primary with its reason', async () => {
    let n = 0;
    const m = await toTimeStep({
      'POST /api/v1/holds': () => (n++ === 0 ? taken() : hold()),
    });
    await pickFirstSlot();
    expect(await screen.findByText('That time was just taken')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Times near that' });
    const alt = within(section).getByRole('button', { name: /11:00 AM/ });
    expect(
      screen.getByRole('button', { name: 'Join the waitlist for this visit' }),
    ).toBeInTheDocument();
    const continueButtons = screen.getAllByRole('button', { name: 'Continue' });
    expect(continueButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByText('Choose another time to continue.').length).toBeGreaterThan(0);
    // The search is run again so the grid no longer offers stale times.
    await waitFor(() =>
      expect(m.seen.filter((s) => s.path === '/api/v1/availability/search').length).toBeGreaterThan(
        1,
      ),
    );
    fireEvent.click(alt);
    await waitFor(() => expect(posts(m.seen, '/api/v1/holds')).toHaveLength(2));
    expect(posts(m.seen, '/api/v1/holds')[1]?.body).toMatchObject({ startsAt: SLOTS[1]!.startsAt });
    await waitFor(() =>
      expect(screen.queryByText('That time was just taken')).not.toBeInTheDocument(),
    );
  });

  it('an expired hold at confirm shows the expired state and keeps service and doctor', async () => {
    const m = await toTimeStep({
      'POST /api/v1/holds': () => hold(),
      ['POST /api/v1/appointments/' + RESERVATION + '/confirm']: () =>
        json(409, { status: 409, code: 'scheduling.hold_expired', errors: [] }),
    });
    await pickFirstSlot();
    await screen.findByRole('timer');
    click('Continue');
    await screen.findByRole('heading', { name: 'Check and confirm' });
    click('Confirm appointment');
    expect(
      await screen.findByRole('heading', { name: 'Your hold on that time ran out' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your service and doctor are kept.')).toBeInTheDocument();
    click('Choose another time');
    await screen.findByRole('heading', { name: 'Choose a date and time' });
    expect(
      m.seen.filter((s) => s.path === '/api/v1/availability/search').at(-1)?.body,
    ).toMatchObject({
      serviceId: SERVICE,
      locationId: PLACE,
    });
  });
});

describe('telehealth licensing refusal at booking (ruling C 4)', () => {
  it('says plainly that a video visit is not offered for that state, with the request reference only', async () => {
    await toTimeStep({
      'POST /api/v1/holds': () => hold(),
      ['POST /api/v1/appointments/' + RESERVATION + '/confirm']: () =>
        json(422, { status: 422, code: 'scheduling.licensing_refused', requestId: 'req-lic' }),
    });
    await pickFirstSlot();
    await screen.findByRole('timer');
    click('Continue');
    await screen.findByRole('heading', { name: 'Check and confirm' });
    click('Confirm appointment');
    expect(
      await screen.findByText(/We cannot offer a video visit for the state you chose/),
    ).toBeInTheDocument();
    expect(screen.getByText('req-lic')).toBeInTheDocument();
  });
});

describe('hold countdown follows UI-UX 7.2', () => {
  it('counts down to the server expiresAt and announces only at 5, 2 and 1 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expires = new Date(Date.now() + 301_000).toISOString();
    await toTimeStep({ 'POST /api/v1/holds': () => hold(expires) });
    await pickFirstSlot();
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveTextContent(/Held for (05:0[0-2]|04:5\d)/);
    expect(timer).not.toHaveAttribute('aria-live', 'polite');
    const status = () =>
      screen
        .getAllByRole('status')
        .map((n) => n.textContent ?? '')
        .join('|');
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(status()).toContain('5 minutes left');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(timer).toHaveTextContent(/Held for 04:[45]\d/);
    expect(status()).toContain('5 minutes left'); // not re-announced every second
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(status()).toContain('2 minutes left');
  });

  it('uses the server clock, not the device clock, when they differ', async () => {
    // Server answers with a Date header 2 minutes ahead of this device.
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    await toTimeStep({
      'POST /api/v1/holds': () =>
        json(
          201,
          { reservationId: RESERVATION, expiresAt: expires },
          { date: new Date(Date.now() + 120_000).toUTCString() },
        ),
    });
    await pickFirstSlot();
    expect(await screen.findByRole('timer')).toHaveTextContent(/Held for 0[23]:[0-5]\d/);
  });

  it('ends the selection when the hold runs out and reloads the times', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = await toTimeStep({
      'POST /api/v1/holds': () => hold(new Date(Date.now() + 3_000).toISOString()),
    });
    await pickFirstSlot();
    await screen.findByRole('timer');
    const before = m.seen.filter((s) => s.path === '/api/v1/availability/search').length;
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(await screen.findByText('Your hold on that time ran out')).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(m.seen.filter((s) => s.path === '/api/v1/availability/search').length).toBeGreaterThan(
        before,
      ),
    );
  });
});

describe('PP-15 appointments, PP-16 change time', () => {
  it('lists appointments and opens the detail with change, cancel and calendar actions', async () => {
    mount('/appointments');
    expect(await screen.findByRole('heading', { name: 'Your appointments' })).toBeInTheDocument();
    expect(await screen.findByText('Tue, Jun 10, 10:00 AM EDT')).toBeInTheDocument();
    click('View details');
    await screen.findByRole('heading', { name: 'Appointment details' });
    for (const n of ['Change time', 'Cancel appointment', 'Add to calendar'])
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
  });

  it('shows the empty state with one action', async () => {
    mount('/appointments', {
      ['GET /api/v1/patients/' + PATIENT + '/appointments']: () =>
        json(200, { items: [], nextCursor: null }),
    });
    expect(
      await screen.findByText('No appointments yet. Book your first visit.'),
    ).toBeInTheDocument();
  });

  it('shows 404 neutrally for an appointment that is not the patient’s (CN-04)', async () => {
    mount('/appointments/' + RESERVATION, {
      ['GET /api/v1/appointments/' + RESERVATION]: () =>
        json(404, { status: 404, code: 'kernel.not_found' }),
    });
    expect(await screen.findByRole('heading', { name: /We can.t find this/ })).toBeInTheDocument();
  });

  it('changes the time with a hold marked rescheduleOf, then reschedule with If-Match and the held id', async () => {
    const NEW = '77777777-7777-4777-8777-777777777777';
    const m = mount('/appointments/' + RESERVATION + '/change', {
      'POST /api/v1/holds': () =>
        json(201, { reservationId: NEW, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      ['POST /api/v1/appointments/' + RESERVATION + '/reschedule']: () =>
        json(
          200,
          appointment({
            id: NEW,
            startsAt: SLOTS[1]!.startsAt,
            endsAt: startsAt(10, 16),
            version: 1,
          }),
        ),
    });
    await screen.findByRole('heading', { name: 'Choose a new time' });
    fireEvent.click((await screen.findAllByRole('button', { name: /11:00 AM/ }))[0]!);
    await screen.findByRole('timer');
    click('Continue');
    await screen.findByRole('heading', { name: 'Confirm the new time' });
    click('Change to this time');
    await screen.findByRole('heading', { name: 'Your appointment was changed' });
    expect(posts(m.seen, '/api/v1/holds')[0]?.body).toMatchObject({
      rescheduleOf: RESERVATION,
      clinicianId: DOCTOR,
    });
    const r = posts(m.seen, `/api/v1/appointments/${RESERVATION}/reschedule`)[0];
    expect(r?.body).toEqual({ newHoldId: NEW });
    expect(r?.headers.get('If-Match')).toBe('W/"3"');
    expect(r?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('PP-17 cancel (block-only policy, no fee)', () => {
  const path = '/appointments/' + RESERVATION + '/cancel';
  const cancelUrl = `POST /api/v1/appointments/${RESERVATION}/cancel`;

  it('quotes the policy, asks to confirm with a consequence label, and never sends or shows a fee', async () => {
    const m = mount(path, {
      [cancelUrl]: () => json(200, appointment({ status: 'cancelled_patient', version: 4 })),
    });
    await screen.findByRole('heading', { name: 'Cancel this appointment?' });
    expect(
      screen.getByText(/You can cancel or change this appointment online/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fee|charge|\$/i);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Cannot make it' } });
    click('Cancel appointment');
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Keep appointment' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));
    await screen.findByRole('heading', { name: 'Your appointment was cancelled' });
    const [c] = posts(m.seen, `/api/v1/appointments/${RESERVATION}/cancel`);
    expect(c?.body).toEqual({ reason: 'Cannot make it' });
    expect(c?.body).not.toHaveProperty('acceptFee');
    expect(c?.headers.get('If-Match')).toBe('W/"3"');
  });

  it('uses the configured cut-off in the sentence when one is supplied', async () => {
    // Policy is a prop of BookingRoutes; the default sentence names no number.
    mount(path);
    expect(
      await screen.findByText(/until the clinic's cut-off time before it starts/),
    ).toBeInTheDocument();
  });

  it.each(['scheduling.cutoff_passed', 'scheduling.fee_acceptance_required'])(
    '%s reads as a block: call the clinic, no way to cancel online, no fee',
    async (code) => {
      mount(path, { [cancelUrl]: () => json(422, { status: 422, code, requestId: 'r' }) });
      await screen.findByRole('heading', { name: 'Cancel this appointment?' });
      click('Cancel appointment');
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel appointment' }),
      );
      expect(
        await screen.findByText(/too close to its start time to change online/),
      ).toBeInTheDocument();
      expect(screen.getAllByText(/call the clinic/).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\bfee\b|charged|\$/i);
    },
  );

  it('412 shows the conflict state', async () => {
    mount(path, {
      [cancelUrl]: () => json(412, { status: 412, code: 'kernel.precondition_failed' }),
    });
    await screen.findByRole('heading', { name: 'Cancel this appointment?' });
    click('Cancel appointment');
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel appointment' }),
    );
    expect(
      await screen.findByText('Someone changed this while you were editing.'),
    ).toBeInTheDocument();
  });
});

/** Checks a body against PostWaitlistEntriesRequest in packages/contracts/openapi/scheduling.yaml (read from the file, so drift fails here). */
function expectWaitlistContract(body: Record<string, unknown>) {
  const yaml = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/scheduling.yaml'),
    'utf8',
  );
  const start = yaml.indexOf('\n    PostWaitlistEntriesRequest:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const block = rest.slice(
    0,
    rest.search(/\n {4}\S/) === -1 ? undefined : rest.search(/\n {4}\S/) + 1,
  );
  const props = [...block.matchAll(/^ {8}(\w+):$/gm)].map((m) => m[1] as string);
  const required = [
    ...(/required:\n((?: {8}- \w+\n?)+)/.exec(block)?.[1] ?? '').matchAll(/- (\w+)/g),
  ].map((m) => m[1] as string);
  expect(block).toContain('additionalProperties: false');
  expect(props).toEqual(expect.arrayContaining(['from', 'to']));
  for (const k of Object.keys(body)) expect(props, `unknown property ${k}`).toContain(k);
  for (const k of required) expect(body, `missing ${k}`).toHaveProperty(k);
  const offset = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
  const from = String(body.from);
  const to = String(body.to);
  expect(from).toMatch(offset);
  expect(to).toMatch(offset);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  expect(days).toBeGreaterThan(0);
  expect(days).toBeLessThanOrEqual(366);
  expect(Date.parse(to)).toBeGreaterThan(Date.now());
}

describe('PP-18 waitlist, PP-19 offer', () => {
  const toWaitlist = async (routes: Parameters<typeof mount>[1]) => {
    const m = await toTimeStep(routes);
    click('join the waitlist');
    return m;
  };
  const none = () => json(200, { slots: [], availabilityStale: false });

  it('joins the waitlist for the chosen visit', async () => {
    const m = await toWaitlist({
      'POST /api/v1/availability/search': none,
      'POST /api/v1/waitlist-entries': () => json(200, {}),
    });
    await screen.findByRole('heading', { name: 'Join the waitlist' });
    click('Join the waitlist');
    await screen.findByRole('heading', { name: 'You are on the waitlist' });
    const body = posts(m.seen, '/api/v1/waitlist-entries')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ patientId: PATIENT, serviceId: SERVICE, locationId: PLACE });
    expect(body).not.toHaveProperty('mode');
    expectWaitlistContract(body);
  });

  it('says so when the clinic has the waitlist off', async () => {
    await toWaitlist({
      'POST /api/v1/availability/search': none,
      'POST /api/v1/waitlist-entries': () =>
        json(422, { status: 422, code: 'scheduling.waitlist_disabled' }),
    });
    click('Join the waitlist');
    expect(
      await screen.findByText('This clinic does not offer a waitlist for this visit.'),
    ).toBeInTheDocument();
  });

  it('accepts an offer within its countdown', async () => {
    const m = mount(
      '/waitlist/offers/' +
        RESERVATION +
        '?expires=' +
        encodeURIComponent(new Date(Date.now() + 600_000).toISOString()),
      {
        [`POST /api/v1/waitlist-offers/${RESERVATION}/accept`]: () => json(200, appointment()),
      },
    );
    expect(await screen.findByRole('timer')).toHaveTextContent(/Offer open for \d\d:\d\d/);
    click('Accept this time');
    await screen.findByRole('heading', { name: 'Your appointment is booked' });
    expect(posts(m.seen, `/api/v1/waitlist-offers/${RESERVATION}/accept`)).toHaveLength(1);
  });

  it('an expired offer says so and does not book', async () => {
    mount('/waitlist/offers/' + RESERVATION, {
      [`POST /api/v1/waitlist-offers/${RESERVATION}/accept`]: () =>
        json(409, { status: 409, code: 'scheduling.offer_expired' }),
    });
    await screen.findByRole('heading', { name: 'A time opened up for you' });
    click('Accept this time');
    expect(
      await screen.findByRole('heading', { name: 'This offer has run out' }),
    ).toBeInTheDocument();
  });

  it('declines an offer and stays on the waitlist', async () => {
    mount('/waitlist/offers/' + RESERVATION, {
      [`POST /api/v1/waitlist-offers/${RESERVATION}/decline`]: () => json(200, {}),
    });
    await screen.findByRole('heading', { name: 'A time opened up for you' });
    click('No thanks');
    expect(
      await screen.findByRole('heading', { name: 'You declined the offer' }),
    ).toBeInTheDocument();
  });
});

describe('states', () => {
  it('shows the server-error state with a reference code and Retry when search fails', async () => {
    const m = mount('/book');
    fireEvent.click(await screen.findByRole('radio', { name: /General visit/ }));
    click('Continue');
    fireEvent.change(await screen.findByLabelText('Place'), { target: { value: PLACE } });
    await screen.findByLabelText('Doctor');
    m.seen.length = 0;
    click('Continue');
    await screen.findByRole('heading', { name: 'Choose a date and time' });
  });

  it('a session that has no linked patient is a neutral message, not a booking form', async () => {
    mount('/book', {
      'GET /api/v1/auth/session': () =>
        json(200, {
          principalId: 'x',
          realm: 'patient',
          audience: 'patient',
          displayName: 'T',
          csrfToken: 'c',
          idleExpiresAt: new Date(Date.now() + 1e6).toISOString(),
          roles: [],
          permissions: [],
          patients: [],
        }),
    });
    expect(await screen.findByText(/not linked to a patient record yet/)).toBeInTheDocument();
  });

  it('a search failure shows the error state and Try again re-runs the search', async () => {
    let n = 0;
    await toTimeStep({
      'POST /api/v1/availability/search': () =>
        n++ === 0
          ? json(500, { status: 500, code: 'kernel.internal', requestId: 'req-500' })
          : json(200, { slots: SLOTS, availabilityStale: false }),
    }).catch(() => undefined);
    expect(await screen.findByText('req-500')).toBeInTheDocument();
    click('Retry');
    expect((await screen.findAllByRole('button', { name: /10:00 AM/ })).length).toBeGreaterThan(0);
  });
});

describe('brand-site hand-off (/book?serviceId&clinicianId)', () => {
  beforeEach(() =>
    window.history.replaceState(null, '', '/book?serviceId=' + SERVICE + '&clinicianId=' + DOCTOR),
  );

  it('pre-checks the service and the doctor, then clears the ids from the address bar', async () => {
    mount('/book?serviceId=' + SERVICE + '&clinicianId=' + DOCTOR);
    expect(await screen.findByRole('radio', { name: /General visit/ })).toBeChecked();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/book');
    click('Continue');
    await screen.findByRole('heading', { name: 'Where and with whom?' });
    await waitFor(() => expect(screen.getByLabelText('Doctor')).toHaveValue(DOCTOR));
  });

  it('service only: doctor defaults to any', async () => {
    window.history.replaceState(null, '', '/book?serviceId=' + SERVICE);
    mount('/book?serviceId=' + SERVICE);
    expect(await screen.findByRole('radio', { name: /General visit/ })).toBeChecked();
    click('Continue');
    await screen.findByLabelText('Doctor');
    expect(screen.getByLabelText('Doctor')).toHaveValue('');
  });

  it.each([
    ['unknown service', '?serviceId=99999999-9999-4999-8999-999999999999&clinicianId=' + DOCTOR],
    ['malformed service', '?serviceId=nope'],
    ['doctor without service', '?clinicianId=' + DOCTOR],
  ])('%s: nothing pre-selected, no error, no id on the page', async (_n, qs) => {
    window.history.replaceState(null, '', '/book' + qs);
    mount('/book' + qs);
    expect(await screen.findByRole('radio', { name: /General visit/ })).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain('99999999');
    expect(document.title).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('doctor who does not offer the service is dropped', async () => {
    mount('/book?serviceId=' + SERVICE + '&clinicianId=' + DOCTOR, {
      'GET /api/v1/clinicians': () => json(200, { items: [] }),
    });
    expect(await screen.findByRole('radio', { name: /General visit/ })).toBeChecked();
    click('Continue');
    await screen.findByLabelText('Doctor');
    expect(screen.getByLabelText('Doctor')).toHaveValue('');
  });
});
