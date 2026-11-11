import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  ALERT,
  ME,
  DOCTOR,
  ENC,
  NOTE,
  PAT,
  RES,
  SUPERVISOR,
  TRAINEE,
  banner,
  encounter,
  json,
  lookupItem,
  mount,
  note,
  noteListItem,
  summary,
  userEvent,
  visit,
} from './testkit.js';
import type { Handler } from './testkit.js';
import { noteStore, workspace } from './workspace.js';

const OLD = '88888888-8888-4888-8888-888888888888';

afterEach(() => {
  cleanup();
  workspace.set(null);
  noteStore.clear();
  vi.useRealTimers();
});

const open = (v?: Record<string, unknown>) =>
  workspace.set({
    patientId: PAT,
    label: 'Amira Okafor',
    ...(v === undefined ? {} : { visit: visit(v) as never }),
  });

describe('chart summary (BR-34, UI-UX 8)', () => {
  it('shows name, date of birth, photo and the allergy block', async () => {
    open();
    mount(DOCTOR, '/patients', (r) =>
      r.path === `/api/v1/patients/${PAT}/chart-summary` ? json(200, summary()) : undefined,
    );
    const b = await screen.findByRole('region', { name: 'Patient' });
    expect(within(b).getByText('Amira Okafor')).toBeVisible();
    expect(within(b).getByText(/1984-03-09/)).toBeVisible();
    expect(b.querySelector('img')).not.toBeNull();
    expect(within(b).getByText('Penicillin')).toBeVisible();
    expect(screen.getByText('Asthma')).toBeVisible();
    expect(screen.getByText('Uncoded: needs review')).toBeVisible();
    expect(screen.getByText('Out of range')).toBeVisible();
  });

  it('draws a hidden allergy part as "not shown", never as "none"', async () => {
    open();
    mount(DOCTOR, '/patients', (r) =>
      r.path.endsWith('/chart-summary')
        ? json(
            200,
            summary({
              level: 'previsit',
              problems: null,
              allergies: null,
              medications: null,
              patientBanner: banner({ allergies: null }),
            }),
          )
        : undefined,
    );
    const b = await screen.findByRole('region', { name: 'Patient' });
    expect(b.querySelector('[data-allergy-state="not-shown"]')).not.toBeNull();
    expect(screen.queryByText(/No allergies recorded/)).toBeNull();
    expect(screen.getAllByText('Not available with your access.').length).toBe(3);
  });

  it('says "No allergies recorded" when none are recorded', async () => {
    open();
    mount(DOCTOR, '/patients', (r) =>
      r.path.endsWith('/chart-summary')
        ? json(
            200,
            summary({
              patientBanner: banner({
                allergies: {
                  state: 'none_recorded',
                  items: [],
                  moreCount: 0,
                  uncodedCount: 0,
                  lastChangedAt: null,
                },
              }),
            }),
          )
        : undefined,
    );
    await screen.findByText('No allergies recorded');
    expect(screen.queryByText(/No known allergies/)).toBeNull();
  });
});

describe('workspace banner (BR-34)', () => {
  it('draws the banner once, as a direct child of the workspace so it sticks over chart, documents and note', async () => {
    open();
    mount(DOCTOR, '/patients', (r) =>
      r.path.endsWith('/chart-summary') ? json(200, summary({})) : undefined,
    );
    const b = await screen.findByRole('region', { name: 'Patient' });
    expect(screen.getAllByRole('region', { name: 'Patient' })).toHaveLength(1);
    expect(b.parentElement?.getAttribute('aria-labelledby')).toBe('workspace-title');
  });
});

describe('break the glass (BR-14, DR-09)', () => {
  const refused = () =>
    json(403, { code: 'clinical.not_assigned', btgAvailable: true, requestId: 'r' });

  it('refuses access until a reason of at least 10 characters is entered, then opens the chart', async () => {
    const user = userEvent.setup();
    open();
    let granted = false;
    const { seen } = mount(DOCTOR, '/patients', (r) => {
      if (r.path.endsWith('/chart-summary')) return granted ? json(200, summary()) : refused();
      if (r.path.endsWith('/break-glass')) {
        granted = true;
        return json(201, { grantId: 'g1', expiresAt: '2031-06-10T13:00:00.000Z' });
      }
      return undefined;
    });
    expect(await screen.findByText(/This patient is not assigned to you/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Patient' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open with emergency access' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(
      within(dlg).getByText('Your access is logged and reviewed by compliance.'),
    ).toBeVisible();
    await user.type(within(dlg).getByLabelText(/Reason for access/), 'too short');
    await user.click(within(dlg).getByRole('button', { name: 'Open chart with emergency access' }));
    expect(within(dlg).getByText('Enter at least 10 characters.')).toBeVisible();
    expect(seen.some((s) => s.path.endsWith('/break-glass'))).toBe(false);
    await user.type(within(dlg).getByLabelText(/Reason for access/), ' - patient collapsed');
    await user.click(within(dlg).getByRole('button', { name: 'Open chart with emergency access' }));
    expect(await screen.findByText('Emergency access')).toBeVisible();
    const post = seen.find((s) => s.path.endsWith('/break-glass'));
    expect(post?.body).toEqual({ reason: 'too short - patient collapsed' });
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole('region', { name: 'Patient' })).toBeVisible();
  });

  it('offers no break-the-glass to a role without audit.btg.open', async () => {
    open();
    mount(TRAINEE, '/patients', (r) => (r.path.endsWith('/chart-summary') ? refused() : undefined));
    await screen.findByText(/This patient is not assigned to you/);
    expect(screen.queryByRole('button', { name: 'Open with emergency access' })).toBeNull();
  });
});

describe('note editor, sign dialog, addenda (DR-03, DR-05, DR-06)', () => {
  function noteHandler(
    extra: (r: Parameters<Parameters<typeof mount>[2]>[0]) => Response | undefined,
  ) {
    return (r: Parameters<Parameters<typeof mount>[2]>[0]) => {
      if (r.path.endsWith('/chart-summary')) return json(200, summary());
      if (r.path === '/api/v1/encounters') return json(201, encounter(), { ETag: 'W/"2"' });
      if (r.path === `/api/v1/encounters/${ENC}/notes`) return json(201, note(), { ETag: 'W/"1"' });
      if (r.method === 'PATCH' && r.path === `/api/v1/notes/${NOTE}`)
        return json(
          200,
          note({
            version: 2,
            body: { sections: (r.body as { sections: Record<string, string> }).sections },
          }),
        );
      return extra(r);
    };
  }

  it('in-progress visit: 409 on POST /encounters lists the drafts and opens only the one the clinician picks (INT03-F20)', async () => {
    const user = userEvent.setup();
    open({});
    const { seen } = mount(DOCTOR, '/patients', (r) => {
      if (r.path.endsWith('/chart-summary')) return json(200, summary());
      if (r.path === '/api/v1/encounters')
        return json(409, { code: 'clinical.invalid_transition', requestId: 'r' });
      if (r.path === `/api/v1/clinicians/${ME}/notes`)
        return json(200, { items: [noteListItem()], nextCursor: null });
      if (r.method === 'GET' && r.path === `/api/v1/notes/${NOTE}`)
        return json(
          200,
          note({
            body: { sections: { subjective: 'Cough', objective: '', assessment: '', plan: '' } },
          }),
          { ETag: 'W/"1"' },
        );
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    await user.click(await screen.findByRole('button', { name: 'Open this draft' }));
    await waitFor(() => expect(screen.getByLabelText('S: Subjective')).toHaveValue('Cough'));
    expect(seen.some((s) => s.path === `/api/v1/notes/${NOTE}`)).toBe(true);
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it('lists the drafts with the signed-in principal even when the schedule item carries no clinicianId (INT03-F20-R3)', async () => {
    const user = userEvent.setup();
    // The schedule item has no clinicianId, so the parsed visit holds '' (types.ts).
    open({ clinicianId: '' });
    const { seen } = mount(DOCTOR, '/patients', (r) => {
      if (r.path.endsWith('/chart-summary')) return json(200, summary());
      if (r.path === '/api/v1/encounters')
        return json(409, { code: 'clinical.invalid_transition', requestId: 'r' });
      if (r.path === `/api/v1/clinicians/${ME}/notes`)
        return json(200, { items: [noteListItem()], nextCursor: null });
      if (r.method === 'GET' && r.path === `/api/v1/notes/${NOTE}`)
        return json(200, note(), { ETag: 'W/"1"' });
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    await user.click(await screen.findByRole('button', { name: 'Open this draft' }));
    expect(seen.some((s) => s.path === '/api/v1/clinicians//notes')).toBe(false);
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it('two drafts for the same patient are never opened automatically (INT03-F20-R1)', async () => {
    const user = userEvent.setup();
    open({});
    const { seen } = mount(DOCTOR, '/patients', (r) => {
      if (r.path.endsWith('/chart-summary')) return json(200, summary());
      if (r.path === '/api/v1/encounters')
        return json(409, { code: 'clinical.invalid_transition', requestId: 'r' });
      if (r.path === `/api/v1/clinicians/${ME}/notes`)
        return json(200, {
          items: [
            noteListItem(),
            noteListItem({
              noteId: OLD,
              encounterId: 'old-enc',
              updatedAt: '2031-05-01T09:00:00.000Z',
            }),
          ],
          nextCursor: null,
        });
      if (r.method === 'GET' && r.path === `/api/v1/notes/${NOTE}`)
        return json(
          200,
          note({
            body: { sections: { subjective: 'Cough', objective: '', assessment: '', plan: '' } },
          }),
          { ETag: 'W/"1"' },
        );
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    expect(await screen.findAllByRole('button', { name: 'Open this draft' })).toHaveLength(2);
    expect(screen.queryByLabelText('S: Subjective')).toBeNull();
    expect(seen.some((s) => s.method === 'GET' && s.path.startsWith('/api/v1/notes/'))).toBe(false);
  });

  it('starts the consultation, saves a draft with If-Match and signs after re-authentication with the same key', async () => {
    const user = userEvent.setup();
    open({});
    let signs = 0;
    const { seen } = mount(
      DOCTOR,
      '/patients',
      noteHandler((r) => {
        if (r.path === `/api/v1/notes/${NOTE}/sign`) {
          signs += 1;
          return signs === 1
            ? json(401, { code: 'auth.reauth_required', requestId: 'r' })
            : json(
                200,
                note({ status: 'signed', version: 3, signedAt: '2031-06-10T09:40:00.000Z' }),
              );
        }
        if (r.path === `/api/v1/notes/${NOTE}/addenda`)
          return json(201, {
            id: 'ad1',
            noteId: NOTE,
            patientId: PAT,
            authorPrincipalId: ME,
            body: (r.body as { body: string }).body,
            signedAt: '2031-06-10T10:00:00.000Z',
          });
        return undefined;
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    const start = seen.find((s) => s.path === '/api/v1/encounters');
    expect(start?.body).toEqual({ reservationId: RES });
    await user.type(await screen.findByLabelText('S: Subjective'), 'Cough for three days');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText(/Draft saved/);
    const patch = seen.find((s) => s.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('W/"1"');
    expect(patch?.body).toMatchObject({ sections: { subjective: 'Cough for three days' } });

    await user.click(screen.getByRole('button', { name: 'Sign and lock note' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByText('Amira Okafor')).toBeVisible();
    expect(within(dlg).getByText(/1984-03-09/)).toBeVisible();
    await user.click(within(dlg).getByRole('button', { name: 'Sign and lock note' }));

    const reauth = await screen.findByRole('alertdialog');
    expect(within(reauth).getByText("Confirm it's you")).toBeVisible();
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    await user.click(within(reauth).getByRole('button', { name: /Sign in again/ }));
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
    await user.click(await screen.findByRole('button', { name: 'Sign now' }));

    expect(await screen.findByText('Note signed and locked')).toBeVisible();
    const signCalls = seen.filter((s) => s.path.endsWith('/sign'));
    expect(signCalls).toHaveLength(2);
    expect(signCalls[0]?.headers.get('Idempotency-Key')).toBe(
      signCalls[1]?.headers.get('Idempotency-Key'),
    );
    expect(signCalls[0]?.headers.get('If-Match')).toBe('W/"2"');
    expect(screen.getByLabelText('S: Subjective')).toHaveAttribute('readonly');

    await user.type(screen.getByLabelText('Addendum text'), 'Result called through');
    await user.click(screen.getByRole('button', { name: 'Add addendum to note' }));
    expect(await screen.findByText('Result called through')).toBeVisible();
    expect(seen.find((s) => s.path.endsWith('/addenda'))?.body).toEqual({
      body: 'Result called through',
    });
  });

  it('shows the consent gate reason and requires a reason for the emergency exception', async () => {
    const user = userEvent.setup();
    open({});
    let call = 0;
    const m = mount(DOCTOR, '/patients', (r) => {
      if (r.path.endsWith('/chart-summary')) return json(200, summary());
      if (r.path === '/api/v1/encounters') {
        call += 1;
        return call === 1
          ? json(409, { code: 'clinical.consents_missing', requestId: 'r' })
          : json(201, encounter());
      }
      if (r.path.endsWith('/notes')) return json(201, note());
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    expect(await screen.findByText('Telehealth consent not signed.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start consultation' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Start with emergency exception' }));
    expect(screen.getByText('Enter a reason for the exception.')).toBeVisible();
    await user.type(screen.getByLabelText(/Reason for the exception/), 'Patient unable to consent');
    await user.click(screen.getByRole('button', { name: 'Start with emergency exception' }));
    await screen.findByLabelText('S: Subjective');
    const second = m.seen.filter((s) => s.path === '/api/v1/encounters')[1];
    expect(second?.body).toEqual({
      reservationId: RES,
      emergencyException: { reason: 'Patient unable to consent' },
    });
  });

  it('lets a trainee submit for co-signature, without a sign permission', async () => {
    const user = userEvent.setup();
    open({});
    mount(
      TRAINEE,
      '/patients',
      noteHandler((r) =>
        r.path === `/api/v1/notes/${NOTE}/sign`
          ? json(200, note({ status: 'pending_cosign', version: 3, cosignRequiredFrom: 'sup' }))
          : undefined,
      ),
      { roles: ['trainee_doctor'] },
    );
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    await user.click(await screen.findByRole('button', { name: 'Submit for co-signature' }));
    const dlg = await screen.findByRole('alertdialog');
    await user.click(within(dlg).getByRole('button', { name: 'Submit for co-signature' }));
    expect(await screen.findByText(/Submitted for co-signature/)).toBeVisible();
    expect(screen.getByLabelText('S: Subjective')).toHaveAttribute('readonly');
  });

  it('keeps the dialog out of the way when the sign is refused (403) and says why', async () => {
    const user = userEvent.setup();
    open({});
    mount(
      DOCTOR,
      '/patients',
      noteHandler((r) =>
        r.path === `/api/v1/notes/${NOTE}/sign` ? json(403, { code: 'auth.forbidden' }) : undefined,
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Start consultation' }));
    await user.click(await screen.findByRole('button', { name: 'Sign and lock note' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Sign and lock note',
      }),
    );
    expect(await screen.findByText("You don't have access to this.")).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('S: Subjective')).not.toHaveAttribute('readonly');
  });
});

describe('notes to sign and co-sign queue (DR-07)', () => {
  const queueHandler =
    (
      over: ((r: Parameters<Handler>[0]) => Response | undefined) | undefined = undefined,
    ): Handler =>
    (r) => {
      if (r.path === `/api/v1/clinicians/${ME}/cosign-queue`)
        return json(200, {
          items: [
            noteListItem({
              status: 'pending_cosign',
              submittedForCosignAt: '2031-06-10T09:30:00.000Z',
            }),
          ],
          nextCursor: null,
        });
      if (r.path === `/api/v1/clinicians/${ME}/notes`)
        return json(200, { items: [noteListItem()], nextCursor: null });
      if (r.method === 'GET' && r.path === `/api/v1/notes/${NOTE}`)
        return json(
          200,
          note({
            status: 'pending_cosign',
            version: 3,
            body: { sections: { subjective: 'Cough', objective: '', assessment: '', plan: '' } },
          }),
          { ETag: 'W/"3"' },
        );
      return over?.(r);
    };

  it('lists the author’s own drafts from the server without the note having been opened here, and resumes one', async () => {
    const user = userEvent.setup();
    const { seen, navigated } = mount(DOCTOR, '/notes-to-sign', queueHandler());
    const open = await screen.findByRole('button', { name: /Open/ });
    expect(screen.getAllByText('Amira Okafor', { exact: false }).length).toBeGreaterThan(0);
    await user.click(open);
    await waitFor(() => expect(navigated).toEqual(['/patients']));
    expect(seen.some((s) => s.method === 'GET' && s.path === `/api/v1/notes/${NOTE}`)).toBe(true);
    expect(workspace.get()?.patientId).toBe(PAT);
    expect(noteStore.get().some((k) => k.note.id === NOTE)).toBe(true);
  });

  it('is offered only with clinical.note.cosign and never calls the queue without it', async () => {
    const { seen } = mount(
      DOCTOR.filter((p) => p !== 'clinical.note.cosign'),
      '/notes-to-sign',
      queueHandler(),
    );
    await screen.findByRole('heading', { name: 'Notes to sign' });
    await screen.findByRole('button', { name: /Open/ });
    expect(screen.queryByRole('tab', { name: /Co-sign queue/ })).toBeNull();
    expect(seen.some((s) => s.path.endsWith('/cosign-queue'))).toBe(false);
  });

  it('shows a queue the supervisor never opened, co-signs after a confirm that restates name and date of birth; a wrong supervisor is refused in words', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { seen } = mount(
      SUPERVISOR,
      '/notes-to-sign',
      queueHandler((r) => {
        if (r.path === `/api/v1/notes/${NOTE}/cosign`) {
          n += 1;
          return n === 1
            ? json(403, { code: 'clinical.cosign_not_supervisor' })
            : json(
                200,
                note({ status: 'signed', version: 4, cosignedAt: '2031-06-10T10:00:00.000Z' }),
              );
        }
        return undefined;
      }),
    );
    await user.click(await screen.findByRole('tab', { name: /Co-sign queue/ }));
    await user.click(await screen.findByRole('button', { name: /Review note/ }));
    expect(await screen.findByText('Cough')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Co-sign note/ }));
    let dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByText('Amira Okafor')).toBeVisible();
    await user.click(within(dlg).getByRole('button', { name: 'Co-sign note' }));
    expect(
      await screen.findByText('Only the supervisor named on this note can co-sign it.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Co-sign note/ }));
    dlg = await screen.findByRole('alertdialog');
    await user.click(within(dlg).getByRole('button', { name: 'Co-sign note' }));
    expect(await screen.findByText('Note co-signed.')).toBeVisible();
    expect(seen.filter((s) => s.path.endsWith('/cosign'))).toHaveLength(2);
  });

  it('says so, with a retry, when the list cannot be read', async () => {
    mount(DOCTOR, '/notes-to-sign', (r) =>
      r.path === `/api/v1/clinicians/${ME}/notes`
        ? json(503, { code: 'kernel.unavailable' })
        : undefined,
    );
    expect(await screen.findByRole('button', { name: /Try again|Retry/i })).toBeVisible();
  });
});

describe('alert tray (UI-UX 7.4)', () => {
  const alert = (over: Record<string, unknown> = {}) => ({
    alertId: ALERT,
    seq: 1,
    type: 'red_flag',
    severity: 'high',
    status: 'open',
    createdAt: '2031-06-10T09:00:00.000Z',
    escalationLevel: 0,
    escalatesAt: '2031-06-10T09:04:10.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgedByDisplayName: null,
    patientId: PAT,
    resourceType: 'triage',
    resourceId: 'x',
    link: null,
    ...over,
  });
  const date = { Date: 'Tue, 10 Jun 2031 09:00:00 GMT' };

  it('counts down from the server Date header, acknowledges once with a key, and shows who after the next read', async () => {
    const user = userEvent.setup();
    let acked = false;
    const { seen } = mount(DOCTOR, '/alerts', (r) => {
      if (r.path === '/api/v1/alerts')
        return json(
          200,
          {
            items: [
              acked
                ? alert({
                    status: 'acknowledged',
                    acknowledgedByDisplayName: 'Dr Lee',
                    acknowledgedAt: '2031-06-10T09:01:00.000Z',
                  })
                : alert(),
            ],
            nextCursor: null,
          },
          date,
        );
      if (r.path === '/api/v1/patients/lookup')
        return json(200, { items: [lookupItem()], truncated: false });
      if (r.path === `/api/v1/alerts/${ALERT}/acknowledge`) {
        acked = true;
        return json(200, {
          alertId: ALERT,
          status: 'acknowledged',
          acknowledgedAt: '2031-06-10T09:01:00.000Z',
          acknowledgedBy: ME,
          escalationLevel: 0,
          escalatesAt: null,
          alreadyAcknowledged: false,
        });
      }
      return undefined;
    });
    expect((await screen.findAllByText(/Red flag/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Escalates in 4:\d\d/)).toBeVisible();
    expect(await screen.findByText(/Amira Okafor, 1984-03-09/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Acknowledge/ }));
    expect(await screen.findByText(/Acknowledged at/)).toBeVisible();
    const ack = seen.find((s) => s.path.endsWith('/acknowledge'));
    expect(ack?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull();
  });

  it('removes a closed alert and says so', async () => {
    const user = userEvent.setup();
    mount(DOCTOR, '/alerts', (r) => {
      if (r.path === '/api/v1/alerts')
        return json(200, { items: [alert()], nextCursor: null }, date);
      if (r.path === '/api/v1/patients/lookup')
        return json(200, { items: [lookupItem()], truncated: false });
      if (r.path.endsWith('/acknowledge')) return json(409, { code: 'notifications.alert_closed' });
      return undefined;
    });
    await user.click(await screen.findByRole('button', { name: /Acknowledge/ }));
    expect(await screen.findByText('This alert is closed.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Acknowledge/ })).toBeNull());
  });

  it('never shows a countdown when the server time is unknown, and says the time is not set', async () => {
    mount(DOCTOR, '/alerts', (r) =>
      r.path === '/api/v1/alerts'
        ? json(200, { items: [alert()], nextCursor: null })
        : r.path === '/api/v1/patients/lookup'
          ? json(200, { items: [lookupItem()], truncated: false })
          : undefined,
    );
    await screen.findByText(/Escalation time not set/);
    expect(screen.queryByText(/Escalates in/)).toBeNull();
  });

  it('shows the paused bar (no dismiss) when the stream is refused, and "Check for alerts" when it drops', async () => {
    const user = userEvent.setup();
    const { stream } = mount(DOCTOR, '/alerts', (r) =>
      r.path === '/api/v1/alerts' ? json(200, { items: [], nextCursor: null }, date) : undefined,
    );
    await screen.findByText('No open alerts.');
    act(() => stream.drop());
    const bar = await screen.findByRole('alert');
    expect(within(bar).getByText('Live alerts are not connected.')).toBeVisible();
    await user.click(within(bar).getByRole('button', { name: 'Check for alerts' }));
    act(() => stream.refuse());
    const paused = await screen.findByText(/Live alerts are paused/);
    const pbar = paused.closest('[role="alert"]') as HTMLElement;
    expect(within(pbar).getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(within(pbar).queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    expect(screen.queryByText('No open alerts.')).toBeVisible();
  });

  it('reloads the list when the stream announces an alert', async () => {
    let reads = 0;
    const { stream } = mount(DOCTOR, '/alerts', (r) => {
      if (r.path === '/api/v1/alerts') {
        reads += 1;
        return json(200, { items: reads > 1 ? [alert()] : [], nextCursor: null }, date);
      }
      if (r.path === '/api/v1/patients/lookup')
        return json(200, { items: [lookupItem()], truncated: false });
      return undefined;
    });
    await screen.findByText('No open alerts.');
    act(() => stream.emit('alert'));
    expect((await screen.findAllByText(/Red flag/)).length).toBeGreaterThan(0);
  });

  it('shows a red-flag bar on other doctor screens, with no close control', async () => {
    mount(DOCTOR, '/patients', (r) =>
      r.path === '/api/v1/alerts'
        ? json(200, { items: [alert()], nextCursor: null }, date)
        : undefined,
    );
    const bar = await screen.findByText(/1 red flag is open/);
    expect(
      within(bar.closest('[role="alert"]') as HTMLElement).queryByRole('button', {
        name: /close|dismiss/i,
      }),
    ).toBeNull();
  });
});

describe('schedule and patient list (DR-01, DR-02)', () => {
  it('lists the doctor’s own schedule and opens a visit in the chart', async () => {
    const user = userEvent.setup();
    const { navigated } = mount(DOCTOR, '/schedule', (r) =>
      r.path === `/api/v1/clinicians/${ME}/schedule`
        ? json(200, { items: [visit()], timeZone: 'UTC' })
        : undefined,
    );
    await user.click(await screen.findByRole('button', { name: /Amira Okafor/ }));
    expect(navigated).toEqual(['/patients']);
    expect(workspace.get()?.visit?.reservationId).toBe(RES);
  });

  it('says so when the role cannot list visits', async () => {
    mount(
      DOCTOR.filter((p) => p !== 'scheduling.booking.own_schedule'),
      '/schedule',
      () => undefined,
    );
    await screen.findByText(/Your role cannot list your own schedule/);
  });

  it('looks up by name with the exact body, opens a chart, and refuses forms the lookup refuses before sending', async () => {
    const user = userEvent.setup();
    const { seen } = mount(DOCTOR, '/patients', (r) =>
      r.path === '/api/v1/patients/lookup'
        ? json(200, { items: [lookupItem()], truncated: true })
        : undefined,
    );
    await user.type(await screen.findByLabelText('Date of birth'), '1984-03-09');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      (await screen.findAllByText(/date of birth alone cannot be searched/)).length,
    ).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('MRN'), 'MRN-0000123');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findAllByText(/Search by MRN alone/)).length).toBeGreaterThan(0);
    expect(seen.some((s) => s.path === '/api/v1/patients/lookup')).toBe(false);
    // a one-letter word is refused too
    const mrn = screen.getByLabelText('MRN') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(mrn, { target: { value: '' } });
    });
    await user.type(screen.getByLabelText('Name'), 'A Okafor');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      (await screen.findAllByText(/up to 4 words of at least 2 letters/)).length,
    ).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Amira Okafor' } });
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/More patients match than are shown/)).toBeVisible();
    const call = seen.find((s) => s.path === '/api/v1/patients/lookup');
    expect(call?.body).toEqual({ name: 'Amira Okafor', dateOfBirth: '1984-03-09' });
    await user.click(screen.getByRole('button', { name: /Open chart/ }));
    expect(workspace.get()?.patientId).toBe(PAT);
  });
});

describe('video and notes side by side (DR-04)', () => {
  it('joins through the adapter only, admits a waiting patient, and ends the call', async () => {
    const user = userEvent.setup();
    open({ mode: 'video' });
    const calls: string[] = [];
    const video = {
      join: (el: HTMLElement, s: { reservationId: string }) => {
        calls.push(`join:${s.reservationId}`);
        el.textContent = 'fake call';
        return Promise.resolve({
          leave: () => {
            calls.push('leave');
            return Promise.resolve();
          },
        });
      },
    };
    let admitted = false;
    const { seen } = mount(
      DOCTOR,
      '/patients',
      (r) => {
        if (r.path.endsWith('/chart-summary')) return json(200, summary());
        if (r.path.endsWith('/video-session/host'))
          return json(200, {
            waiting: admitted
              ? []
              : [{ id: 'part1', displayName: 'Amira Okafor', admission: 'waiting' }],
          });
        if (r.path.endsWith('/video-session/admit')) {
          admitted = true;
          return json(200, {});
        }
        if (r.path.endsWith('/video-session/end')) return json(200, {});
        return undefined;
      },
      { video },
    );
    await user.click(await screen.findByRole('button', { name: 'Join the call' }));
    expect(await screen.findByText('You are in the call.')).toBeVisible();
    expect(calls).toEqual([`join:${RES}`]);
    expect(await screen.findByRole('button', { name: /Start consultation/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Admit/ }));
    await screen.findByText('Nobody is waiting.');
    expect(seen.find((s) => s.path.endsWith('/admit'))?.body).toEqual({ participantId: 'part1' });
    await user.click(screen.getByRole('button', { name: 'End the call' }));
    expect(await screen.findByText('The call has ended.')).toBeVisible();
    expect(calls).toEqual([`join:${RES}`, 'leave']);
  });

  it('says video is not connected when no adapter is configured, and notes still work', async () => {
    open({ mode: 'video' });
    mount(DOCTOR, '/patients', (r) =>
      r.path.endsWith('/chart-summary')
        ? json(200, summary())
        : r.path.endsWith('/host')
          ? json(200, { waiting: [] })
          : undefined,
    );
    expect(await screen.findByText(/Video is not connected in this environment/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start consultation' })).toBeEnabled();
  });
});
