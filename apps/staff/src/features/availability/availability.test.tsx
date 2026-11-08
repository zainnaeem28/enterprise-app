import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import {
  BLK,
  DOCTOR,
  LOC,
  ME,
  TPL,
  blocked,
  json,
  mount,
  rule,
  template,
  userEvent,
} from './testkit.js';
import type { Handler } from './testkit.js';
import { localDate } from './affected.js';
import { PREVIEW_DAYS } from './preview.js';

afterEach(() => cleanup());

const user = userEvent.setup();
const TEMPLATES = `/api/v1/clinicians/${ME}/availability-templates`;
const BLOCKED = `/api/v1/clinicians/${ME}/blocked-times`;
const SCHEDULE = `/api/v1/clinicians/${ME}/schedule`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const tomorrow = localDate(new Date(), 'UTC', 1);
const tomorrowWeekday = new Date(`${tomorrow}T12:00:00Z`).getUTCDay();
const otherWeekday = (tomorrowWeekday + 3) % 7;

/** The doctor works the weekday of tomorrow (and another one) and has one visit tomorrow at 10:00 UTC. */
function hoursHandler(
  extra: Handler = () => undefined,
  over: { schedule?: Handler } = {},
): Handler {
  return (r) => {
    const e = extra(r);
    if (e !== undefined) return e;
    if (r.path === TEMPLATES && r.method === 'GET')
      return json(200, {
        items: [template([tomorrowWeekday, otherWeekday])],
        nextCursor: null,
      });
    if (r.path === SCHEDULE) {
      const o = over.schedule?.(r);
      if (o !== undefined) return o;
      const date = r.search.get('date');
      return json(200, {
        timeZone: 'UTC',
        items:
          date === tomorrow
            ? [
                {
                  reservationId: 'x',
                  patientId: 'p',
                  patientName: 'Not Shown',
                  mrn: null,
                  serviceId: 's',
                  mode: 'in_person',
                  status: 'confirmed',
                  startsAt: `${tomorrow}T10:00:00.000Z`,
                  endsAt: `${tomorrow}T10:30:00.000Z`,
                  checkedInAt: null,
                  queueStage: null,
                },
              ]
            : [],
      });
    }
    return undefined;
  };
}

async function openEditor() {
  await user.click(await screen.findByRole('button', { name: 'Change hours' }));
  return screen.findByRole('form', { name: 'Change hours' });
}

describe('weekly hours (DR-11)', () => {
  it('lists the active hours of the location with their validity', async () => {
    mount(DOCTOR, hoursHandler());
    expect(await screen.findByText('From 2020-01-01, no end date')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change hours' })).toBeVisible();
  });

  it('shows an empty state and offers to set hours up', async () => {
    mount(DOCTOR, (r) =>
      r.path === TEMPLATES ? json(200, { items: [], nextCursor: null }) : undefined,
    );
    expect(await screen.findByText('You have no weekly hours at this location yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set up weekly hours' })).toBeVisible();
  });

  it('shows the appointments a change would leave outside the hours before it saves, and saves only after acknowledgement', async () => {
    const { seen } = mount(
      DOCTOR,
      hoursHandler((r) =>
        r.method === 'PUT' && r.path === `${TEMPLATES}/${TPL}`
          ? json(200, template([otherWeekday], { version: 4 }), { ETag: 'W/"4"' })
          : undefined,
      ),
    );
    const form = await openEditor();
    const day = WEEKDAYS[tomorrowWeekday] as string;
    await user.click(within(form).getByRole('button', { name: `Remove hours 1 on ${day}` }));
    await user.click(within(form).getByRole('button', { name: 'Check affected appointments' }));

    expect(
      await screen.findByText('1 upcoming appointment falls outside these hours.'),
    ).toBeVisible();
    expect(screen.getByText(/Saving does not cancel or move them/)).toBeVisible();
    // No patient name or detail is read into the preview.
    expect(screen.queryByText('Not Shown')).toBeNull();
    // The check read today plus the next 13 days, and nothing was saved yet.
    expect(seen.filter((s) => s.path === SCHEDULE)).toHaveLength(PREVIEW_DAYS);
    expect(seen.some((s) => s.method === 'PUT')).toBe(false);

    const save = screen.getByRole('button', { name: 'Save hours' });
    expect(save).toBeDisabled();
    await user.click(
      screen.getByLabelText('I understand these appointments stay booked outside my hours'),
    );
    expect(save).toBeEnabled();
    await user.click(save);

    expect(await screen.findByText('Saved. New searches use these hours now.')).toBeVisible();
    const put = seen.find((s) => s.method === 'PUT') as (typeof seen)[number];
    expect(put.headers.get('If-Match')).toBe('W/"3"');
    const body = put.body as {
      locationId: string;
      rules: { weekday: number; serviceIds: unknown }[];
    };
    expect(body.locationId).toBe(LOC);
    expect(body.rules.map((x) => x.weekday)).toEqual([otherWeekday]);
    // Services of an existing rule are kept as the server sent them.
    expect(body.rules[0]?.serviceIds).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it('saves straight after the check when no appointment is affected', async () => {
    const { seen } = mount(
      DOCTOR,
      hoursHandler((r) =>
        r.method === 'PUT' ? json(200, template([tomorrowWeekday]), { ETag: 'W/"4"' }) : undefined,
      ),
    );
    const form = await openEditor();
    const day = WEEKDAYS[otherWeekday] as string;
    await user.click(within(form).getByRole('button', { name: `Remove hours 1 on ${day}` }));
    await user.click(within(form).getByRole('button', { name: 'Check affected appointments' }));
    expect(
      await screen.findByText('No upcoming appointment falls outside these hours.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('Saved. New searches use these hours now.')).toBeVisible();
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(1);
  });

  it('does not offer to save when the appointments could not be checked', async () => {
    const { seen } = mount(
      DOCTOR,
      hoursHandler(undefined, {
        schedule: (r) =>
          r.search.get('date') === null ? undefined : json(503, { code: 'kernel.unavailable' }),
      }),
    );
    const form = await openEditor();
    await user.click(within(form).getByRole('button', { name: 'Check affected appointments' }));
    expect(await screen.findByText(/we cannot save yet/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save hours' })).toBeNull();
    expect(seen.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('refuses an end before the start and names the field, without calling the server', async () => {
    const { seen } = mount(DOCTOR, hoursHandler());
    const form = await openEditor();
    const day = WEEKDAYS[tomorrowWeekday] as string;
    await user.set(within(form).getByLabelText(`${day}, hours 1: until`), '08:00');
    await user.click(within(form).getByRole('button', { name: 'Check affected appointments' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `${day}, hours 1: the end must be after the start.`,
    );
    expect(seen.filter((s) => s.path === SCHEDULE)).toHaveLength(0);
  });

  it('creates new hours with one idempotency key and no If-Match', async () => {
    const { seen } = mount(
      DOCTOR,
      hoursHandler((r) => {
        if (r.path === TEMPLATES && r.method === 'GET')
          return json(200, { items: [], nextCursor: null });
        if (r.path === TEMPLATES && r.method === 'POST')
          return json(201, template([1, 2, 3, 4, 5]), { ETag: 'W/"1"' });
        return undefined;
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Set up weekly hours' }));
    await user.click(await screen.findByRole('button', { name: 'Check affected appointments' }));
    await screen.findByText('No upcoming appointment falls outside these hours.');
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    await screen.findByText('Saved. New searches use these hours now.');
    const post = seen.find((s) => s.method === 'POST') as (typeof seen)[number];
    expect(post.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers.get('If-Match')).toBeNull();
    expect((post.body as { rules: unknown[] }).rules).toHaveLength(5);
  });

  it('explains a 412 in words and keeps the form', async () => {
    mount(
      DOCTOR,
      hoursHandler((r) =>
        r.method === 'PUT' ? json(412, { code: 'kernel.precondition_failed' }) : undefined,
      ),
    );
    const form = await openEditor();
    await user.click(within(form).getByRole('button', { name: 'Check affected appointments' }));
    await screen.findByText(/No upcoming appointment|upcoming appointment/);
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText(/Someone changed this while you were editing/)).toBeVisible();
    expect(screen.getByRole('form', { name: 'Change hours' })).toBeVisible();
  });

  it('stops using hours only after showing the affected appointments', async () => {
    const { seen } = mount(
      DOCTOR,
      hoursHandler((r) =>
        r.method === 'DELETE'
          ? json(200, template([], { status: 'retired', version: 4 }))
          : undefined,
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Stop using these hours' }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Stop using these hours?' });
    expect(
      await within(dlg)
        .findByText('2 upcoming appointments fall outside these hours.')
        .catch(() => null),
    ).toBeNull();
    expect(
      await within(dlg).findByText('1 upcoming appointment falls outside these hours.'),
    ).toBeVisible();
    const go = within(dlg).getByRole('button', { name: 'Stop using these hours' });
    expect(go).toBeDisabled();
    await user.click(
      within(dlg).getByLabelText('I understand these appointments stay booked outside my hours'),
    );
    await user.click(go);
    expect(await screen.findByText('These hours are no longer used.')).toBeVisible();
    const del = seen.find((s) => s.method === 'DELETE') as (typeof seen)[number];
    expect(del.headers.get('If-Match')).toBe('W/"3"');
  });

  it('says plainly when the role cannot manage hours, and does not call the route', async () => {
    const { seen } = mount(['calendar.link.own'], () => undefined);
    expect(await screen.findByText(/Your role cannot change this part/)).toBeVisible();
    expect(seen.some((s) => s.path === TEMPLATES)).toBe(false);
  });

  it('shows a load error with a retry when the list cannot be read', async () => {
    mount(DOCTOR, (r) =>
      r.path === TEMPLATES
        ? json(500, { code: 'kernel.unavailable', requestId: 'req-1' })
        : undefined,
    );
    expect(await screen.findByText(/req-1/)).toBeVisible();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeVisible();
  });
});

describe('leave and blocked time (DR-12)', () => {
  async function fill(start = '2031-07-01T08:00', end = '2031-07-03T17:00') {
    await user.click(await screen.findByRole('tab', { name: 'Leave and blocked time' }));
    await user.set(await screen.findByLabelText('From'), start);
    await user.set(screen.getByLabelText('Until'), end);
  }
  const list: Handler = (r) =>
    r.path === BLOCKED && r.method === 'GET'
      ? json(200, { items: [blocked()], nextCursor: null })
      : undefined;

  it('lists upcoming leave', async () => {
    mount(DOCTOR, list);
    await user.click(await screen.findByRole('tab', { name: 'Leave and blocked time' }));
    expect(await screen.findByText('Annual leave')).toBeVisible();
  });

  it('checks the period without saving, shows counts only, and needs acknowledgement before saving', async () => {
    const { seen } = mount(DOCTOR, (r) => {
      if (r.path === BLOCKED && r.method === 'POST') {
        const b = r.body as { dryRun?: boolean; acknowledgeConflicts?: boolean };
        if (b.dryRun === true)
          return json(200, {
            saved: false,
            conflicts: { total: 3, held: 1, confirmed: 1, checked_in: 1 },
          });
        if (b.acknowledgeConflicts === true)
          return json(201, {
            ...blocked(),
            saved: true,
            conflicts: { total: 3, held: 1, confirmed: 1, checked_in: 1 },
          });
        return json(409, { code: 'scheduling.conflicts_with_appointments' });
      }
      return list(r);
    });
    await fill();
    await user.click(screen.getByRole('button', { name: 'Check affected appointments' }));
    expect(
      await screen.findByText(
        '3 appointments are booked in this period: 1 confirmed, 1 on hold, 1 arrived.',
      ),
    ).toBeVisible();
    const post = seen.filter((s) => s.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toMatchObject({ dryRun: true, kind: 'leave' });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText('I understand these appointments stay booked'));
    await user.click(save);
    expect(await screen.findByText(/Those hours are no longer offered/)).toBeVisible();
    const saved = seen.filter((s) => s.method === 'POST')[1] as (typeof seen)[number];
    expect(saved.body).toMatchObject({ acknowledgeConflicts: true });
    expect((saved.body as { dryRun?: boolean }).dryRun).toBeUndefined();
    expect(saved.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('saves without acknowledgement when nothing is booked in the period', async () => {
    const { seen } = mount(DOCTOR, (r) => {
      if (r.path === BLOCKED && r.method === 'POST') {
        const b = r.body as { dryRun?: boolean };
        const conflicts = { total: 0, held: 0, confirmed: 0, checked_in: 0 };
        return b.dryRun === true
          ? json(200, { saved: false, conflicts })
          : json(201, { ...blocked(), saved: true, conflicts });
      }
      return list(r);
    });
    await fill();
    await user.click(screen.getByRole('button', { name: 'Check affected appointments' }));
    expect(await screen.findByText('No appointment is booked in this period.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Those hours are no longer offered/);
    expect(
      (seen.filter((s) => s.method === 'POST')[1]?.body as Record<string, unknown>)[
        'acknowledgeConflicts'
      ],
    ).toBeUndefined();
  });

  it('asks again with the new count when bookings arrive between the check and the save', async () => {
    let first = true;
    mount(DOCTOR, (r) => {
      if (r.path === BLOCKED && r.method === 'POST') {
        const b = r.body as { dryRun?: boolean };
        if (b.dryRun === true)
          return json(200, {
            saved: false,
            conflicts: { total: 0, held: 0, confirmed: 0, checked_in: 0 },
          });
        if (first) {
          first = false;
          return json(409, {
            code: 'scheduling.conflicts_with_appointments',
            errors: [
              { path: '/conflicts/held', code: '0' },
              { path: '/conflicts/confirmed', code: '2' },
              { path: '/conflicts/checked_in', code: '0' },
            ],
          });
        }
      }
      return list(r);
    });
    await fill();
    await user.click(screen.getByRole('button', { name: 'Check affected appointments' }));
    await screen.findByText('No appointment is booked in this period.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Appointments were booked in this period since you checked/),
    ).toBeVisible();
    expect(
      screen.getByText(
        '2 appointments are booked in this period: 2 confirmed, 0 on hold, 0 arrived.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('names the field when the end is not after the start, without calling the server', async () => {
    const { seen } = mount(DOCTOR, list);
    await fill('2031-07-03T08:00', '2031-07-01T08:00');
    await user.click(screen.getByRole('button', { name: 'Check affected appointments' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/make the end later than the start/);
    expect(seen.some((s) => s.method === 'POST')).toBe(false);
  });

  it('removes a period after confirmation', async () => {
    const { seen } = mount(DOCTOR, (r) =>
      r.method === 'DELETE' && r.path === `${BLOCKED}/${BLK}`
        ? new Response(null, { status: 204 })
        : list(r),
    );
    await user.click(await screen.findByRole('tab', { name: 'Leave and blocked time' }));
    await user.click(await screen.findByRole('button', { name: /^Remove leave from/ }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Remove this period?' });
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed.')).toBeVisible();
  });

  it('is limited by permission', async () => {
    mount(['calendar.link.own'], () => undefined);
    await user.click(await screen.findByRole('tab', { name: 'Leave and blocked time' }));
    expect(await screen.findByText(/Your role cannot change this part/)).toBeVisible();
  });
});

describe('Google Calendar connection (DR-13)', () => {
  const link =
    (status: string, extra: Record<string, unknown> = {}): Handler =>
    (r) =>
      r.path === '/api/v1/calendar-link' && r.method === 'GET'
        ? json(200, { status, ...extra })
        : undefined;
  const open = async () => user.click(await screen.findByRole('tab', { name: 'Google Calendar' }));

  it('disconnected: shows the consent text and the busy-only note before the connect button', async () => {
    mount(DOCTOR, link('not_linked'));
    await open();
    expect(await screen.findByText('Not connected')).toBeVisible();
    expect(screen.getByText('What you are agreeing to')).toBeVisible();
    expect(screen.getByText(/Busy-only sync: we read only the times you are busy/)).toBeVisible();
    expect(screen.getByText(/two permissions only/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('connect sends the browser to the Google consent address the server gave', async () => {
    const go = vi.fn();
    mount(
      DOCTOR,
      (r) =>
        r.path === '/api/v1/calendar-link/start'
          ? json(200, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })
          : link('not_linked')(r),
      { go },
    );
    await open();
    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s'),
    );
  });

  it('refuses to follow an address that is not Google', async () => {
    const go = vi.fn();
    mount(
      DOCTOR,
      (r) =>
        r.path === '/api/v1/calendar-link/start'
          ? json(200, { authorizationUrl: 'https://evil.example/auth' })
          : link('not_linked')(r),
      { go },
    );
    await open();
    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    expect(await screen.findByText(/unexpected address/)).toBeVisible();
    expect(go).not.toHaveBeenCalled();
  });

  it('says so, in place, when starting fails', async () => {
    mount(DOCTOR, (r) =>
      r.path === '/api/v1/calendar-link/start'
        ? json(403, { code: 'auth.forbidden' })
        : link('not_linked')(r),
    );
    await open();
    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    expect(await screen.findByText(/could not start the connection/)).toBeVisible();
  });

  it('connected: shows the state, the last sync and the busy-only note, and offers disconnect', async () => {
    mount(
      DOCTOR,
      link('active', {
        googleCalendarId: 'primary',
        lastSyncedAt: '2031-06-10T09:00:00.000Z',
        lastErrorCode: null,
      }),
    );
    await open();
    expect(await screen.findByText('Connected')).toBeVisible();
    expect(screen.getByText(/Last synced/)).toBeVisible();
    expect(screen.getByText(/Busy-only sync/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  it('waiting for Google: offers to connect again', async () => {
    mount(DOCTOR, link('pending_consent'));
    await open();
    expect(await screen.findByText('Waiting for Google')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
  });

  it.each([
    ['token_revoked', 'Connection needs attention', /Google says access was removed/],
    ['error', 'Connection problem', /could not read your calendar/],
  ])('%s: draws an error state with words, not colour alone', async (status, title, body) => {
    mount(DOCTOR, link(status, { lastErrorCode: 'x' }));
    await open();
    expect(await screen.findByText(title)).toBeVisible();
    expect(screen.getByText(body)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  it('disconnect asks first, then calls DELETE once', async () => {
    const { seen } = mount(DOCTOR, (r) =>
      r.method === 'DELETE' && r.path === '/api/v1/calendar-link'
        ? json(200, {})
        : link('active', { lastSyncedAt: null })(r),
    );
    await open();
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Disconnect Google Calendar?' });
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Disconnected.')).toBeVisible();
    expect(seen.filter((s) => s.method === 'DELETE')).toHaveLength(1);
  });

  it.each([
    ['?calendar=linked', 'Connected. Google Calendar is now kept in sync.'],
    ['?calendar=denied', 'You did not approve access at Google, so nothing was connected.'],
    ['?calendar=error', 'Google could not finish connecting. Nothing was changed. Try again.'],
  ])(
    'the return from Google (%s) opens this section and says what happened',
    async (search, text) => {
      mount(DOCTOR, link('not_linked'), { search });
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByRole('tab', { name: 'Google Calendar', selected: true })).toBeVisible();
    },
  );

  it('ignores an unknown return word', async () => {
    mount(DOCTOR, hoursHandler(), { search: '?calendar=<script>' });
    expect(await screen.findByRole('tab', { name: 'Weekly hours', selected: true })).toBeVisible();
  });

  it('is limited by permission', async () => {
    mount(['scheduling.template.manage'], () => undefined);
    await open();
    expect(await screen.findByText(/Your role cannot change this part/)).toBeVisible();
  });
});

describe('the whole screen', () => {
  it('says so when the account has no location', async () => {
    mount(DOCTOR, hoursHandler(), { locations: [] });
    expect(await screen.findByText(/not assigned to a location/)).toBeVisible();
  });
});

describe('rule defaults', () => {
  it('keeps room and overbooking of a rule as sent', () => {
    expect(rule(1, { roomId: 'r', overbookable: true })).toMatchObject({
      roomId: 'r',
      overbookable: true,
    });
  });
});
