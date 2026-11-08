import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json } from '../../app/test-helpers.js';
import {
  CONSENT,
  DOC,
  ME,
  RES,
  RESPONSE,
  etag,
  forVisit,
  mount,
  previsitBody,
  sent,
  violations,
} from './testkit.js';
import { matchPrevisitRoute } from './routes.js';
import { answersOf, missingRequired } from './pages/QuestionnairePage.js';
import { parsePrevisit, parseTemplate } from './types.js';

afterEach(cleanup);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const PREVISIT = `/api/v1/appointments/${RES}/previsit`;
const QUESTIONNAIRE = `/api/v1/appointments/${RES}/questionnaire`;
const HUB = `/appointments/${RES}/previsit`;

describe('routes and parsers', () => {
  it('matches only the reservation id in the path', () => {
    expect(matchPrevisitRoute(`${HUB}/consents`)).toEqual({ name: 'consents', reservationId: RES });
    expect(matchPrevisitRoute(HUB)).toEqual({ name: 'hub', reservationId: RES });
    expect(matchPrevisitRoute('/appointments/not-an-id/previsit')).toBeUndefined();
    expect(matchPrevisitRoute(`${HUB}/other`)).toBeUndefined();
  });
  it('refuses a previsit body without the three flags', () => {
    expect(parsePrevisit({ reservationId: RES, questionnaire: true })).toBeUndefined();
    expect(parsePrevisit(previsitBody())?.consentItems).toHaveLength(1);
  });
  it('reads a required question as required unless the template says otherwise', () => {
    const t = parseTemplate({
      key: 'k',
      version: 1,
      schema: {
        questions: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', required: false },
        ],
      },
    });
    expect(t?.questions.map((q) => q.required)).toEqual([true, false]);
    expect(missingRequired(t!.questions, { b: '' })).toEqual(['a']);
    expect(answersOf({ a: '', b: false, c: undefined, d: 0 })).toEqual({ b: false, d: 0 });
  });
});

describe('pre-visit overview (PP-25..27)', () => {
  it('shows each item as To do, Done or Needs fixing and says the consultation is blocked', async () => {
    mount(HUB, {
      ['GET ' + PREVISIT]: () => json(200, previsitBody({ questionnaire: true })),
      [`GET /api/v1/patients/${ME}/documents`]: () =>
        json(200, {
          items: [
            {
              id: DOC,
              patientId: ME,
              classification: 'insurance_card',
              status: 'quarantined',
              uploadedAt: '2031-01-01T00:00:00.000Z',
              onLegalHold: false,
            },
          ],
        }),
    });
    expect(await screen.findByRole('heading', { name: 'Before your visit' })).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Pre-visit items' })).getAllByRole(
      'listitem',
    );
    expect(within(items[0]!).getByText('Done')).toBeInTheDocument();
    expect(within(items[1]!).getByText('To do')).toBeInTheDocument();
    await waitFor(() => expect(within(items[2]!).getByText('Needs fixing')).toBeInTheDocument());
    expect(screen.getByText('Your consultation cannot start yet')).toBeInTheDocument();
  });

  it('does not warn about the gate when every consent is signed', async () => {
    mount(HUB, {
      ['GET ' + PREVISIT]: () =>
        json(
          200,
          previsitBody({
            consents: true,
            questionnaire: true,
            insurance: true,
            requiredConsents: [],
          }),
        ),
    });
    await screen.findByRole('heading', { name: 'Before your visit' });
    expect(screen.queryByText('Your consultation cannot start yet')).not.toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(3);
  });

  it('a 404 reads the same as nothing there, with no hint what exists', async () => {
    mount(HUB, {
      ['GET ' + PREVISIT]: () =>
        json(404, { status: 404, code: 'kernel.not_found', requestId: 'req-1' }),
    });
    expect(await screen.findByText(/can.t find this/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const m = mount(HUB);
    await screen.findByRole('heading', { name: 'Before your visit' });
    expect(await violations(m.view.container)).toEqual([]);
  });
});

describe('PP-26 consents', () => {
  it('keeps the gate closed until signed; sending needs the box and a typed name', async () => {
    const m = mount(`${HUB}/consents`, {
      ['POST /api/v1/consents/' + CONSENT + '/sign']: () =>
        json(200, { id: CONSENT, status: 'signed' }),
    });
    expect(await screen.findByRole('heading', { name: 'Consent forms' })).toBeInTheDocument();
    expect(screen.getByText('Your consultation cannot start yet')).toBeInTheDocument();
    expect(screen.getByText('SYNTHETIC consent wording for tests.')).toBeInTheDocument();
    click('Sign');
    expect(
      await screen.findByText('Tick the box to say you have read this form'),
    ).toBeInTheDocument();
    expect(sent(m.seen, 'POST', `/api/v1/consents/${CONSENT}/sign`)).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('I have read this form and I agree.'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), {
      target: { value: 'Sam Example' },
    });
    click('Sign');
    expect(await screen.findByText('Signed. This stays on your record.')).toBeInTheDocument();
    const call = sent(m.seen, 'POST', `/api/v1/consents/${CONSENT}/sign`);
    expect(call).toHaveLength(1);
    expect(call[0]?.body).toEqual({ typedName: 'Sam Example' });
    expect(call[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says plainly when the API gives no consent text, and offers no signing', async () => {
    mount(`${HUB}/consents`, {
      ['GET ' + PREVISIT]: () => json(200, previsitBody({ requiredConsents: undefined })),
    });
    expect(await screen.findByText('The forms cannot be shown here yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign' })).not.toBeInTheDocument();
  });

  it('an outdated consent is Needs fixing', async () => {
    mount(`${HUB}/consents`, {
      ['GET ' + PREVISIT]: () =>
        json(
          200,
          previsitBody({
            requiredConsents: [
              {
                id: CONSENT,
                templateKey: 'telehealth',
                title: 'Telehealth consent',
                text: 'v2',
                status: 'outdated',
              },
            ],
          }),
        ),
    });
    expect(await screen.findByText('Needs fixing')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const m = mount(`${HUB}/consents`);
    await screen.findByRole('heading', { name: 'Consent forms' });
    expect(await violations(m.view.container)).toEqual([]);
  });
});

describe('PP-25 questionnaire and PP-22 emergency advice', () => {
  const PUT = 'PUT /api/v1/questionnaire-responses/*';
  const SUBMIT = 'POST /api/v1/questionnaire-responses/*/submit';
  const saved = (version: number) => (s: { body: Record<string, unknown> | undefined }) =>
    json(
      version === 1 ? 201 : 200,
      {
        id: RESPONSE,
        answers: s.body?.['answers'] ?? {},
        status: 'in_progress',
        redFlag: false,
        version,
      },
      etag(version),
    );
  const submitted = (redFlag: boolean) => () =>
    json(
      200,
      {
        redFlag,
        ...(redFlag ? { advice: 'SYNTHETIC advice text from the template.' } : {}),
        response: { id: RESPONSE, answers: {}, status: 'submitted', redFlag, version: 2 },
      },
      etag(2),
    );
  const fill = async () => {
    await screen.findByRole('heading', { name: 'Health questionnaire' });
    fireEvent.click(screen.getByLabelText('No'));
    fireEvent.change(screen.getByLabelText('Why are you coming in?'), {
      target: { value: 'check-up' },
    });
    fireEvent.change(screen.getByLabelText('Do you smoke?'), { target: { value: 'never' } });
  };

  it('blocks a blank required question without a request and does not echo values in the summary', async () => {
    const m = mount(`${HUB}/questionnaire`);
    await screen.findByRole('heading', { name: 'Health questionnaire' });
    fireEvent.change(screen.getByLabelText('Why are you coming in?'), {
      target: { value: 'private detail' },
    });
    click('Send my answers');
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText(/Do you have chest pain now\?/)).toBeInTheDocument();
    expect(summary.textContent).not.toContain('private detail');
    expect(m.seen.filter((s) => s.method !== 'GET')).toHaveLength(0);
  });

  it('saves a draft with a client-chosen response id and no If-Match the first time', async () => {
    const m = mount(`${HUB}/questionnaire`, { [PUT]: saved(1) });
    await screen.findByRole('heading', { name: 'Health questionnaire' });
    fireEvent.click(screen.getByLabelText('Yes'));
    click('Save and continue later');
    expect(
      await screen.findByText('Your answers are saved. You can finish later.'),
    ).toBeInTheDocument();
    const put = m.seen.find((s) => s.method === 'PUT')!;
    expect(put.path).toMatch(/^\/api\/v1\/questionnaire-responses\/[0-9a-f-]{36}$/);
    expect(put.headers.get('if-match')).toBeNull();
    expect(put.body).toEqual({
      reservationId: RES,
      templateKey: 'general',
      answers: { chest_pain: true },
    });
  });

  it('submits with If-Match, then a red flag shows the advice from the template and a call link', async () => {
    const m = mount(`${HUB}/questionnaire`, { [PUT]: saved(1), [SUBMIT]: submitted(true) });
    await fill();
    click('Send my answers');
    expect(
      await screen.findByRole('heading', { name: 'Please read this now' }),
    ).toBeInTheDocument();
    expect(screen.getByText('SYNTHETIC advice text from the template.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    const post = m.seen.find((s) => s.method === 'POST' && s.path.endsWith('/submit'))!;
    expect(post.headers.get('if-match')).toBe('W/"1"');
    expect(post.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.location.pathname).not.toContain('advice');
  });

  it('no red flag goes back to the list without the emergency screen', async () => {
    mount(`${HUB}/questionnaire`, { [PUT]: saved(1), [SUBMIT]: submitted(false) });
    await fill();
    click('Send my answers');
    expect(await screen.findByRole('heading', { name: 'Before your visit' })).toBeInTheDocument();
    expect(screen.queryByText('Please read this now')).not.toBeInTheDocument();
  });

  it('a stale version shows the conflict state and keeps what was typed', async () => {
    mount(`${HUB}/questionnaire`, {
      ['GET ' + QUESTIONNAIRE]: () =>
        json(
          200,
          forVisit({
            id: RESPONSE,
            answers: { reason: 'old' },
            status: 'in_progress',
            redFlag: false,
            version: 1,
          }),
          etag(1),
        ),
      [PUT]: () =>
        json(412, { status: 412, code: 'kernel.precondition_failed', requestId: 'req-2' }),
    });
    await screen.findByRole('heading', { name: 'Health questionnaire' });
    fireEvent.change(screen.getByLabelText('Why are you coming in?'), {
      target: { value: 'new text' },
    });
    click('Save and continue later');
    expect(
      await screen.findByText('Someone changed this while you were editing.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Why are you coming in?')).toHaveValue('new text');
  });

  it('a submitted questionnaire is read-only', async () => {
    mount(`${HUB}/questionnaire`, {
      ['GET ' + QUESTIONNAIRE]: () =>
        json(
          200,
          forVisit({ id: RESPONSE, answers: {}, status: 'submitted', redFlag: false, version: 2 }),
          etag(2),
        ),
    });
    expect(await screen.findByText('Sent to the clinic')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send my answers' })).not.toBeInTheDocument();
  });

  it('has no axe violations on the form and on the emergency screen', async () => {
    const m = mount(`${HUB}/questionnaire`);
    await screen.findByRole('heading', { name: 'Health questionnaire' });
    expect(await violations(m.view.container)).toEqual([]);
    cleanup();
    const e = mount(`${HUB}/emergency`);
    await screen.findByRole('heading', { name: 'Please read this now' });
    expect(await violations(e.view.container)).toEqual([]);
  });
});

describe('PP-27 insurance card', () => {
  const put = () => async () => ({ ok: true, status: 200 });
  const ticket = () =>
    json(201, { documentId: DOC, uploadUrl: 'https://objects.test/put', uploadHeaders: {} });
  const doc = (status: string) => ({
    id: DOC,
    patientId: ME,
    classification: 'insurance_card',
    status,
    uploadedAt: '2031-01-01T00:00:00.000Z',
    onLegalHold: false,
  });

  it('uploads a file through create, put and complete, shows the scan state, then saves the card with the document id', async () => {
    const puts: string[] = [];
    let status = 'scanning';
    const { InsurancePage } = await import('./pages/InsurancePage.js');
    const { PrevisitContext } = await import('./ctx.js');
    const { createPrevisitApi } = await import('./api.js');
    const { mockApi } = await import('./testkit.js');
    const { runtimeWith } = await import('../../app/test-helpers.js');
    const { render } = await import('@testing-library/react');
    const kit = mockApi({
      ['POST /api/v1/patients/' + ME + '/document-uploads']: ticket,
      ['POST /api/v1/document-uploads/' + DOC + '/complete']: () => json(200, doc('scanning')),
      ['GET /api/v1/patients/' + ME + '/documents']: () => json(200, { items: [doc(status)] }),
      ['POST /api/v1/patients/' + ME + '/insurance-coverages']: (s) =>
        json(201, {
          id: 'c1',
          patientId: ME,
          payerName: s.body?.['payerName'],
          memberId: s.body?.['memberId'],
          active: true,
          rowVersion: 1,
          frontDocumentId: DOC,
        }),
    });
    const h = runtimeWith(kit.respond);
    const api = createPrevisitApi(h.runtime);
    const view = render(
      <PrevisitContext.Provider
        value={{
          runtime: h.runtime,
          api,
          go: () => undefined,
          reservationId: RES,
          patientId: ME,
          previsit: parsePrevisit(previsitBody())!,
          reload: () => undefined,
          advice: undefined,
          setAdvice: () => undefined,
        }}
      >
        <InsurancePage
          pollMs={10}
          putObject={async (url) => {
            puts.push(url);
            return put()();
          }}
        />
      </PrevisitContext.Provider>,
    );
    await screen.findByRole('heading', { name: 'Insurance card' });
    const file = new File(['x'], 'card.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose a photo or PDF of the front'), {
      target: { files: [file] },
    });
    expect(await screen.findByText('Checking the file for safety')).toBeInTheDocument();
    expect(puts).toEqual(['https://objects.test/put']);
    status = 'clean';
    expect(await screen.findByText('Checked and ready')).toBeInTheDocument();
    click('Save insurance details');
    expect(await screen.findByText('Enter the insurance company')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Insurance company'), {
      target: { value: 'Example Health' },
    });
    fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: 'M-123' } });
    click('Save insurance details');
    expect(
      await screen.findByText(
        'Your insurance details were saved. The clinic checks them before your visit.',
      ),
    ).toBeInTheDocument();
    const post = sent(kit.seen, 'POST', `/api/v1/patients/${ME}/insurance-coverages`);
    expect(post[0]?.body).toEqual({
      payerName: 'Example Health',
      memberId: 'M-123',
      frontDocumentId: DOC,
    });
    expect(post[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await violations(view.container)).toEqual([]);
  });

  it('refuses a file type that is not allowed before any request, and a rejected file asks for a new photo', async () => {
    const m = mount(`${HUB}/insurance`, {
      ['GET /api/v1/patients/' + ME + '/documents']: () =>
        json(200, { items: [doc('quarantined')] }),
      ['GET /api/v1/patients/' + ME + '/insurance-coverages']: () =>
        json(200, {
          items: [
            {
              id: 'c1',
              patientId: ME,
              payerName: 'P',
              memberId: 'M',
              active: true,
              rowVersion: 1,
              frontDocumentId: DOC,
            },
          ],
        }),
    });
    await screen.findByRole('heading', { name: 'Insurance card' });
    expect(await screen.findByText('Needs fixing: the file was not accepted')).toBeInTheDocument();
    click('Save insurance details');
    expect(
      await screen.findByText('Upload a new photo for the file that was not accepted'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Replace the front'), {
      target: { files: [new File(['x'], 'a.exe', { type: 'application/x-msdownload' })] },
    });
    expect(await screen.findByText(/This file type is not accepted/)).toBeInTheDocument();
    expect(sent(m.seen, 'POST', `/api/v1/patients/${ME}/document-uploads`)).toHaveLength(0);
  });
});
