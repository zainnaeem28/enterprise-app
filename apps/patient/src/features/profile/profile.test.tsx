import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json } from '../../app/test-helpers.js';
import { ME, OTHER, GRANT, etag, mount, prefsBody, profileBody, sent } from './testkit.js';
import { patchOf, validate } from './pages/ProfilePage.js';
import { ageOutNotice } from './pages/FamilyPage.js';
import { bodyOf } from './pages/NotificationsPage.js';
import { violations } from '../../axe-helper.js';

afterEach(cleanup);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const PROFILE = `/api/v1/patients/${ME}/profile`;
const PREFS = `/api/v1/patients/${ME}/communication-preferences`;

describe('PP-35 profile and contact details', () => {
  it('shows the record, sends only the changed field with If-Match, and says what changed', async () => {
    const m = mount('profile', '/profile', {
      ['PATCH ' + PROFILE]: () =>
        json(200, profileBody({ phone: '+15550100999', version: 4 }), etag(4)),
    });
    expect(await screen.findByRole('heading', { name: 'Your details' })).toBeInTheDocument();
    expect(screen.getByText('Sam Example')).toBeInTheDocument();
    expect(document.title).toBe('Patient portal - Your details');
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '555 010 0999' } });
    click('Save my details');
    expect(await screen.findByText('Your details were saved')).toBeInTheDocument();
    const patch = sent(m.seen, 'PATCH', PROFILE);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.body).toEqual({ phone: '555 010 0999' });
    expect(patch[0]?.headers.get('if-match')).toBe('W/"3"');
    expect(screen.getByText(/Changed: Phone number/)).toBeInTheDocument();
  });

  it('puts an address together from its parts and sends it whole', () => {
    const was = {
      phone: '',
      email: '',
      line1: '1 Test Street',
      line2: '',
      city: 'Testville',
      postalCode: '10001',
      stateCode: 'AA',
      preferredLanguage: 'en',
      pharmacyName: '',
    };
    expect(patchOf({ ...was, city: 'Newtown' }, was)).toEqual({
      address: { line1: '1 Test Street', city: 'Newtown', postalCode: '10001' },
    });
  });

  it('refuses a bad email or state without a request, and the summary does not echo the value', async () => {
    const m = mount('profile', '/profile');
    await screen.findByRole('heading', { name: 'Your details' });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'N1' } });
    click('Save my details');
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText(/Email address: enter it like/)).toBeInTheDocument();
    expect(summary.textContent).not.toContain('not-an-email');
    expect(sent(m.seen, 'PATCH', PROFILE)).toHaveLength(0);
  });

  it('does not let a value be emptied', () => {
    const was = {
      phone: '+1555',
      email: 'a@b.test',
      line1: '',
      line2: '',
      city: '',
      postalCode: '',
      stateCode: '',
      preferredLanguage: 'en',
      pharmacyName: '',
    };
    expect(validate({ ...was, phone: '' }, was)['phone']).toMatch(/cannot be left empty/);
  });

  it('on 412 keeps what was typed in the side panel and reloads on request', async () => {
    const m = mount('profile', '/profile', {
      ['PATCH ' + PROFILE]: () =>
        json(412, { status: 412, code: 'kernel.precondition_failed', requestId: 'r1' }),
    });
    await screen.findByRole('heading', { name: 'Your details' });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '555 010 0777' } });
    click('Save my details');
    expect(
      await screen.findByText('Someone changed this while you were editing.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('What you typed')).toHaveTextContent('555 010 0777');
    click('Reload and review changes');
    await waitFor(() => expect(sent(m.seen, 'GET', PROFILE).length).toBe(2));
  });

  it('shows the server field errors as inline messages', async () => {
    mount('profile', '/profile', {
      ['PATCH ' + PROFILE]: () =>
        json(400, {
          status: 400,
          code: 'kernel.validation_failed',
          errors: [{ path: '/phone', code: 'kernel.invalid_value' }],
        }),
    });
    await screen.findByRole('heading', { name: 'Your details' });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '5550100999' } });
    click('Save my details');
    expect(await screen.findAllByText(/Phone number: this was not accepted/)).not.toHaveLength(0);
  });

  it('saves an emergency contact', async () => {
    const m = mount('profile', '/profile', {
      [`PATCH /api/v1/patients/${ME}/contacts/cccccccc-cccc-4ccc-8ccc-cccccccccccc`]: () =>
        json(200, {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          kind: 'emergency',
          name: 'Alex E',
          rowVersion: 3,
        }),
    });
    await screen.findByRole('heading', { name: 'Emergency contact' });
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Alex E' } });
    click('Save emergency contact');
    expect(await screen.findByText('Emergency contact saved.')).toBeInTheDocument();
    const p = sent(
      m.seen,
      'PATCH',
      `/api/v1/patients/${ME}/contacts/cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
    )[0];
    expect(p?.headers.get('if-match')).toBe('W/"2"');
    expect(p?.body).toMatchObject({ kind: 'emergency', name: 'Alex E' });
  });

  it('a proxy-only account sees a permission note and no profile call is made', async () => {
    const m = mount(
      'profile',
      '/profile',
      {},
      { patients: [{ patientId: OTHER, relation: 'proxy', scope: 'appointments' }] },
    );
    expect(
      await screen.findByText(/Only the patient can see and change their own details/),
    ).toBeInTheDocument();
    expect(m.seen.some((s) => s.path.endsWith('/profile'))).toBe(false);
  });

  it('shows the server error state with the reference on a 500', async () => {
    mount('profile', '/profile', {
      ['GET ' + PROFILE]: () =>
        json(500, { status: 500, code: 'kernel.internal', requestId: 'req-500' }),
    });
    expect(await screen.findByText(/req-500/)).toBeInTheDocument();
  });
});

describe('PP-36 notification preferences', () => {
  it('shows the portal channel switched on and locked, with the safety-notice sentence', async () => {
    mount('profile', '/profile/notifications');
    const box = await screen.findByRole('checkbox', { name: 'In the patient portal' });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(
      screen.getByText(
        /Safety and security notices are always shown in the portal and cannot be switched off/,
      ),
    ).toBeInTheDocument();
  });

  it('always includes in_app in what it sends, even when every other channel is off', async () => {
    const m = mount('profile', '/profile/notifications', {
      ['PUT ' + PREFS]: () =>
        json(200, prefsBody({ channels: ['in_app'], rowVersion: 5 }), etag(5)),
    });
    await screen.findByRole('checkbox', { name: 'Email' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
    click('Save preferences');
    expect(await screen.findByText('Your preferences were saved')).toBeInTheDocument();
    const put = sent(m.seen, 'PUT', PREFS)[0];
    expect(put?.body?.['channels']).toEqual(['in_app']);
    expect(put?.headers.get('if-match')).toBe('W/"4"');
    expect(
      bodyOf(
        { channels: [], reminderChannel: '', quiet: false, start: '', end: '', timeZone: '' },
        'en',
      )['channels'],
    ).toEqual(['in_app']);
  });

  it('sends no If-Match on the first save and explains an unavailable channel', async () => {
    const m = mount('profile', '/profile/notifications', {
      ['GET ' + PREFS]: () => json(200, prefsBody({ stored: false, rowVersion: null })),
      ['PUT ' + PREFS]: () =>
        json(422, { status: 422, code: 'patient.channel_unavailable', requestId: 'r2' }),
      ['GET ' + PROFILE]: () => json(200, profileBody({ phone: null }), etag(3)),
    });
    const sms = await screen.findByRole('checkbox', { name: /Text message/ });
    expect(await screen.findByText(/Add a phone number under Your details/)).toBeInTheDocument();
    fireEvent.click(sms);
    click('Save preferences');
    expect(await screen.findByText(/needs a phone number or email address/)).toBeInTheDocument();
    expect(sent(m.seen, 'PUT', PREFS)[0]?.headers.get('if-match')).toBeNull();
  });

  it('requires different quiet-hours times', async () => {
    const m = mount('profile', '/profile/notifications');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Use quiet hours' }));
    fireEvent.change(screen.getByLabelText(/Quiet hours end/), { target: { value: '22:00' } });
    click('Save preferences');
    expect(
      (await screen.findAllByText(/the start and the end must be different times/)).length,
    ).toBeGreaterThan(0);
    expect(sent(m.seen, 'PUT', PREFS)).toHaveLength(0);
  });
});

describe('PP-06..PP-09 family and proxy access', () => {
  const grant = (status: string) => ({
    id: GRANT,
    patientId: ME,
    relationship: 'parent',
    scope: 'appointments',
    patientDisplayName: 'Pat P',
    status,
  });

  it('states what a linked person can see and shows each status as text', async () => {
    mount('profile', '/family', {
      [`GET /api/v1/patients/${ME}/proxies`]: () =>
        json(200, { items: [grant('requested')], nextCursor: null }),
    });
    expect(
      await screen.findByText(
        /You choose whether they can also see your messages and your documents/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('Waiting for the clinic to check')).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('removes access only after the confirm dialog, and says so', async () => {
    const m = mount('profile', '/family', {
      [`GET /api/v1/patients/${ME}/proxies`]: () =>
        json(200, { items: [grant('active')], nextCursor: null }),
      [`DELETE /api/v1/patients/${ME}/proxies/${GRANT}`]: () => json(200, {}),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove access' }));
    expect(sent(m.seen, 'DELETE', `/api/v1/patients/${ME}/proxies/${GRANT}`)).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    expect(await violations()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove access' }));
    expect(await screen.findByText(/Access was removed/)).toBeInTheDocument();
    expect(sent(m.seen, 'DELETE', `/api/v1/patients/${ME}/proxies/${GRANT}`)).toHaveLength(1);
  });

  it('lists the people the account acts for, and switches', async () => {
    mount(
      'profile',
      '/family',
      {},
      {
        patients: [
          { patientId: ME, relation: 'self', scope: 'full' },
          { patientId: OTHER, relation: 'proxy', scope: 'appointments', displayName: 'Jo K' },
        ],
      },
    );
    expect(await screen.findByRole('heading', { name: 'People you act for' })).toBeInTheDocument();
    expect(screen.getAllByText('Appointments').length).toBeGreaterThan(0);
    click('Book for this person');
    expect(await screen.findByText('Booking for this person')).toBeInTheDocument();
    expect((screen.getByLabelText('Booking for') as HTMLSelectElement).value).toBe(OTHER);
  });

  const full = (over: Record<string, unknown>) => ({
    ...grant('active'),
    scopes: ['appointments'],
    effectiveScopes: ['appointments'],
    guardian: false,
    ...over,
  });
  const GRANTS = `/api/v1/patients/${ME}/proxies`;

  it('ruling C 3: the patient grants messages per scope, appointments stay on, and the list reloads', async () => {
    const m = mount('profile', '/family', {
      [`GET ${GRANTS}`]: () => json(200, { items: [full({})], nextCursor: null }),
      [`PUT ${GRANTS}/${GRANT}/scopes`]: () =>
        json(200, full({ scopes: ['appointments', 'messages'] })),
    });
    const box = await screen.findByRole('checkbox', { name: 'Messages' });
    expect(screen.getByRole('checkbox', { name: 'Appointments' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save what they can see' })).toBeDisabled();
    expect(await violations()).toEqual([]);
    fireEvent.click(box);
    click('Save what they can see');
    expect(await screen.findByText(/Saved\. What they can see has changed/)).toBeInTheDocument();
    expect(sent(m.seen, 'PUT', `${GRANTS}/${GRANT}/scopes`)[0]?.body).toEqual({
      scopes: ['appointments', 'messages'],
    });
  });

  it('ruling C 3: a guardian link cannot be edited by the patient', async () => {
    const m = mount('profile', '/family', {
      [`GET ${GRANTS}`]: () => json(200, { items: [full({ guardian: true })], nextCursor: null }),
    });
    expect(await screen.findByText(/The clinic manages this link/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Messages' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save what they can see' })).toBeNull();
    expect(sent(m.seen, 'PUT', `${GRANTS}/${GRANT}/scopes`)).toHaveLength(0);
  });

  it('ruling C 3: an open invitation shows the masked address and can be cancelled', async () => {
    mount('profile', '/family', {
      [`GET ${GRANTS}`]: () =>
        json(200, {
          items: [full({ status: 'invited', inviteeHint: 'p***@example.com' })],
          nextCursor: null,
        }),
    });
    expect(await screen.findByText('Invitation sent')).toBeInTheDocument();
    expect(screen.getByText('Sent to p***@example.com.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel invitation' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it('ruling C 3: the age-out notice appears only within 30 days of the grant end date', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000);
    const far = new Date(Date.now() + 90 * 86_400_000);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(ageOutNotice({ validUntil: iso(far), status: 'active' } as never)).toBeUndefined();
    mount('profile', '/family', {
      [`GET ${GRANTS}`]: () =>
        json(200, {
          items: [
            full({ validUntil: iso(soon) }),
            full({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', validUntil: iso(far) }),
          ],
          nextCursor: null,
        }),
    });
    expect(
      await screen.findByText(`This access ends on ${iso(soon)} (in 10 days).`),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(iso(far)))).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it('ruling C 3: a proxy leaves only after the confirm dialog', async () => {
    const m = mount(
      'profile',
      '/family',
      { [`POST /api/v1/proxy-grants/${GRANT}/leave`]: () => new Response(null, { status: 204 }) },
      {
        patients: [
          { patientId: ME, relation: 'self', scope: 'full' },
          {
            patientId: OTHER,
            relation: 'proxy',
            scope: 'appointments',
            displayName: 'Jo K',
            grantId: GRANT,
          },
        ],
      },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(sent(m.seen, 'POST', `/api/v1/proxy-grants/${GRANT}/leave`)).toHaveLength(0);
    const dialog = await screen.findByRole('alertdialog');
    expect(await violations()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText(/You left\./)).toBeInTheDocument();
    expect(sent(m.seen, 'POST', `/api/v1/proxy-grants/${GRANT}/leave`)).toHaveLength(1);
  });

  it('ruling C 3: the verification screen sends the code and gives one answer for any refusal', async () => {
    const path = `/api/v1/proxy-invites/${GRANT}/accept`;
    let n = 0;
    const m = mount('profile', `/family/accept/${GRANT}`, {
      [`POST ${path}`]: () =>
        ++n === 1
          ? json(422, { status: 422, code: 'identity.proxy_code_invalid', requestId: 'r9' })
          : json(200, full({})),
    });
    await screen.findByRole('button', { name: 'Confirm' });
    click('Confirm');
    expect((await screen.findAllByText(/enter the code from the email/)).length).toBeGreaterThan(0);
    expect(sent(m.seen, 'POST', path)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Code from the email'), { target: { value: '123456' } });
    click('Confirm');
    expect(await screen.findByText('That code was not accepted')).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    expect(document.body.textContent).not.toContain('123456');
    click('Confirm');
    expect(await screen.findByRole('heading', { name: 'You are linked' })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    expect(sent(m.seen, 'POST', path)[1]?.body).toEqual({ code: '123456' });
  });

  it('PP-07: D-7 not configured reads as not open yet and never as sent', async () => {
    const m = mount('profile', '/family/add', {
      [`POST /api/v1/patients/${ME}/proxy-requests`]: () =>
        json(422, { status: 422, code: 'identity.proxy_rules_not_configured', requestId: 'r3' }),
    });
    fireEvent.change(await screen.findByLabelText('Their email address'), {
      target: { value: 'pat@example.com' },
    });
    click('Send request');
    expect(await screen.findByText('Linking family members is not open yet')).toBeInTheDocument();
    expect(screen.queryByText('Request sent')).not.toBeInTheDocument();
    const req = sent(m.seen, 'POST', `/api/v1/patients/${ME}/proxy-requests`)[0];
    expect(req?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req?.body).toEqual({ relationship: 'parent', email: 'pat@example.com' });
  });

  it('PP-07: a created request is shown as sent', async () => {
    mount('profile', '/family/add', {
      [`POST /api/v1/patients/${ME}/proxy-requests`]: () => json(201, {}),
    });
    fireEvent.change(await screen.findByLabelText('Their email address'), {
      target: { value: 'pat@example.com' },
    });
    click('Send request');
    expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument();
  });

  it('PP-07: email is required and checked before anything is sent', async () => {
    const m = mount('profile', '/family/add', {});
    await screen.findByLabelText('Their email address');
    click('Send request');
    expect((await screen.findAllByText(/Their email address: enter it\./)).length).toBeGreaterThan(
      0,
    );
    fireEvent.change(screen.getByLabelText('Their email address'), { target: { value: 'nope' } });
    click('Send request');
    expect((await screen.findAllByText(/like name@example\.com/)).length).toBeGreaterThan(0);
    expect(sent(m.seen, 'POST', `/api/v1/patients/${ME}/proxy-requests`)).toHaveLength(0);
  });

  it('PP-07: a 422 on the email is shown on the field', async () => {
    mount('profile', '/family/add', {
      [`POST /api/v1/patients/${ME}/proxy-requests`]: () =>
        json(422, {
          status: 422,
          code: 'kernel.validation_failed',
          requestId: 'r4',
          errors: [{ path: '/email', code: 'invalid' }],
        }),
    });
    fireEvent.change(await screen.findByLabelText('Their email address'), {
      target: { value: 'pat@example.com' },
    });
    click('Send request');
    expect((await screen.findAllByText(/this was not accepted/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Request sent')).not.toBeInTheDocument();
  });
});
