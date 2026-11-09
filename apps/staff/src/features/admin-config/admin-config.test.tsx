import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configStrings as s } from './strings.js';
import {
  ID,
  integration,
  json,
  location,
  page,
  policy,
  portal,
  problem,
  service,
} from './testkit.js';
import type { Seen } from './testkit.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const serious = async (container: HTMLElement) => {
  const r = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
};
const writes = (seen: Seen[]) => seen.filter((x) => x.method !== 'GET');

describe('Services catalogue (AD-06): neutral display name', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.path.endsWith('/admin/services') && x.method === 'GET')
        return page([
          service(1),
          service(2, {
            internalName: 'HIV clinic',
            patientDisplayName: 'Clinic visit',
            conditionRevealing: true,
          }),
        ]);
      return problem(404, 'kernel.not_found');
    };

  it('lists services and shows what patients see', async () => {
    const { ui } = portal('/admin/services', routes());
    render(ui);
    expect(await screen.findByText('HIV clinic')).toBeInTheDocument();
    expect(screen.getByText('Clinic visit')).toBeInTheDocument();
  });

  it('refuses a condition-revealing service without a different patient-facing name, before any call', async () => {
    const { ui, seen } = portal('/admin/services', routes());
    render(ui);
    await screen.findByText('HIV clinic');
    await click(new RegExp(`^${s.add}`));
    type('Internal name', 'HIV clinic');
    type('Length (minutes)', '30');
    type('How it is held', 'either');
    fireEvent.click(screen.getByLabelText('The service name would reveal a condition'));
    type('Name patients see', 'hiv clinic');
    await click(s.save);
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getAllByText(new RegExp(s.neutralRequired)).length).toBeGreaterThan(0);
    expect(screen.getByText(s.neutralNote)).toBeInTheDocument();
  });

  it('saves a neutral name and reloads with audit left to the server', async () => {
    const { ui, seen } = portal(
      '/admin/services',
      routes((x) => (x.method === 'POST' ? json(200, service(3), { ETag: 'W/"1"' }) : undefined)),
    );
    render(ui);
    await screen.findByText('HIV clinic');
    await click(new RegExp(`^${s.add}`));
    type('Internal name', 'Sexual health');
    type('Length (minutes)', '30');
    type('How it is held', 'video');
    fireEvent.click(screen.getByLabelText('The service name would reveal a condition'));
    type('Name patients see', 'Private consultation');
    expect(screen.getByText(s.patientSees('Private consultation'))).toBeInTheDocument();
    await click(s.save);
    await screen.findByText(s.saved);
    const post = writes(seen)[0];
    expect(post?.method).toBe('POST');
    expect(post?.body).toMatchObject({
      internalName: 'Sexual health',
      patientDisplayName: 'Private consultation',
      conditionRevealing: true,
      durationMin: 30,
      mode: 'video',
    });
  });

  it('shows the server neutral-name refusal next to the field and keeps what was typed', async () => {
    const { ui } = portal(
      '/admin/services',
      routes((x) =>
        x.method === 'PATCH'
          ? problem(422, 'organisation.neutral_name_required', {
              errors: [{ path: '/patientDisplayName', code: 'x' }],
            })
          : undefined,
      ),
    );
    render(ui);
    await screen.findByText('HIV clinic');
    await click(`${s.edit}: Service 1`);
    type('Internal name', 'Service one');
    await click(s.save);
    expect(await screen.findByText(s.neutralServer)).toBeInTheDocument();
    expect(screen.getByLabelText('Internal name')).toHaveValue('Service one');
  });
});

describe('Booking policies (AD-07): block-only', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/booking-policies'))
        return page([policy(1), policy(2, { lateChange: 'fee' })]);
      if (x.method === 'GET' && x.path.endsWith('/services')) return page([service(30)]);
      if (x.method === 'GET' && x.path.endsWith('/locations')) return page([location(40)]);
      return problem(404, 'kernel.not_found');
    };

  it('offers blocking only for a new policy and says nothing is charged', async () => {
    const { ui, seen } = portal(
      '/admin/policies',
      routes((x) => (x.method === 'POST' ? json(200, policy(3)) : undefined)),
    );
    render(ui);
    await screen.findAllByText(s.blockOnly);
    await click(new RegExp(`^${s.add}`));
    const select = screen.getByLabelText('Changes inside the cut-off') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['block']);
    expect(screen.getByText(s.blockNote)).toBeInTheDocument();
    type('Service', ID(30));
    await click(s.save);
    await screen.findByText(s.saved);
    expect(writes(seen)[0]?.body).toMatchObject({ serviceId: ID(30), lateChange: 'block' });
  });

  it('shows a stored fee as stored only and lets the administrator switch it to blocking with If-Match', async () => {
    const { ui, seen } = portal(
      '/admin/policies',
      routes((x) => (x.method === 'PATCH' ? json(200, policy(2)) : undefined)),
    );
    render(ui);
    await screen.findByText(s.feeStored);
    const edits = screen.getAllByRole('button', { name: /^Edit: Service 30/ });
    await act(async () => {
      fireEvent.click(edits[1] as HTMLElement);
    });
    expect(screen.getByText(s.feeConverted)).toBeInTheDocument();
    type('Changes inside the cut-off', 'block');
    await click(s.save);
    await screen.findByText(s.saved);
    const patch = writes(seen)[0];
    expect(patch?.method).toBe('PATCH');
    expect(patch?.headers.get('if-match')).toBe('W/"1"');
    expect(patch?.body).toEqual({ id: ID(2), lateChange: 'block' });
  });
});

describe('Clinics (AD-04)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method !== 'GET') return problem(404, 'kernel.not_found');
      if (x.path.endsWith('/locations')) return page([location(40)]);
      if (x.path.endsWith('/rooms')) return page([]);
      if (x.path.endsWith('/opening-hours'))
        return page([
          { locationId: ID(40), weekday: 1, opens: '09:00', closes: '17:00', rowVersion: 3 },
        ]);
      if (x.path.endsWith('/holidays')) return page([]);
      return problem(404, 'kernel.not_found');
    };

  it('lists locations, empty rooms and holidays, and the hours by day', async () => {
    const { ui } = portal('/admin/clinics', routes());
    render(ui);
    expect((await screen.findAllByText('Clinic 40')).length).toBeGreaterThan(0);
    expect(await screen.findByText(s.roomsEmpty)).toBeInTheDocument();
    expect(await screen.findByText(s.holidaysEmpty)).toBeInTheDocument();
    expect(await screen.findByText('Monday')).toBeInTheDocument();
  });

  it('changes opening hours by their natural key with If-Match and refuses a closing time before opening', async () => {
    const { ui, seen } = portal(
      '/admin/clinics',
      routes((x) =>
        x.method === 'PATCH'
          ? json(200, {
              locationId: ID(40),
              weekday: 1,
              opens: '09:00',
              closes: '18:00',
              rowVersion: 4,
            })
          : undefined,
      ),
    );
    render(ui);
    await screen.findByText('Monday');
    await click(/^Edit: Monday 09:00/);
    type('Closes', '08:00');
    await click(s.save);
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getAllByText(/Closing time must be after opening time/).length).toBeGreaterThan(
      0,
    );
    type('Closes', '18:00');
    await click(s.save);
    await screen.findByText(s.saved);
    const patch = writes(seen)[0];
    expect(patch?.headers.get('if-match')).toBe('W/"3"');
    expect(patch?.body).toEqual({
      locationId: ID(40),
      weekday: 1,
      opens: '09:00',
      closes: '18:00',
    });
  });

  it('removes an interval in-band after a confirmation step', async () => {
    const { ui, seen } = portal(
      '/admin/clinics',
      routes((x) =>
        x.method === 'PATCH'
          ? json(200, { locationId: ID(40), weekday: 1, opens: '09:00', removed: true })
          : undefined,
      ),
    );
    render(ui);
    await screen.findByText('Monday');
    await click(/^Edit: Monday 09:00/);
    await click(s.remove);
    expect(writes(seen)).toHaveLength(0);
    const confirm = screen.getByText(/^Remove: Monday/).closest('div') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: s.remove }));
    });
    await screen.findByText(s.removed);
    expect(writes(seen)[0]?.body).toEqual({
      locationId: ID(40),
      weekday: 1,
      opens: '09:00',
      remove: true,
    });
  });

  it('says the row changed when If-Match is stale, and reloads', async () => {
    const { ui } = portal(
      '/admin/clinics',
      routes((x) =>
        x.method === 'PATCH' ? problem(412, 'kernel.precondition_failed') : undefined,
      ),
    );
    render(ui);
    await screen.findAllByText('Clinic 40');
    await click(/^Edit: Clinic 40/);
    type('Name', 'Renamed');
    await click(s.save);
    expect(await screen.findByText(s.conflict)).toBeInTheDocument();
  });
});

describe('Integrations (AD-09)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/integrations'))
        return page([
          integration(50),
          integration(51, { kind: 'sms', vendor: 'twilio', health: 'down', lastTestAt: null }),
        ]);
      return problem(404, 'kernel.not_found');
    };

  it('shows each connection with its health in words', async () => {
    const { ui } = portal('/admin/integrations', routes());
    render(ui);
    expect((await screen.findAllByText(s.health.ok)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(s.health.down).length).toBeGreaterThan(0);
    expect(screen.getAllByText('E-mail').length).toBeGreaterThan(0);
  });

  it('runs the connection test and shows the returned health', async () => {
    const { ui, seen } = portal(
      '/admin/integrations',
      routes((x) =>
        x.method === 'POST' && x.path.endsWith('/test')
          ? json(200, { health: 'degraded', checkedAt: '2026-11-09T09:00:00.000Z' })
          : undefined,
      ),
    );
    render(ui);
    await screen.findAllByText('Text messages');
    await click(`${s.testNow}: Text messages`);
    await screen.findByText(new RegExp(`Test result: ${s.health.degraded}`));
    expect(writes(seen)[0]?.path).toBe(`/api/v1/admin/integrations/${ID(51)}/test`);
  });

  it('sends a secret once, clears it at once, and never displays it', async () => {
    const SECRET = 'sk-live-very-secret-value';
    const { ui, seen } = portal(
      '/admin/integrations',
      routes((x) => (x.method === 'PUT' ? json(200, { versionId: 'v-7' }) : undefined)),
    );
    const { container } = render(ui);
    await screen.findAllByText('Text messages');
    const names = screen.getAllByLabelText(s.secretName);
    const values = screen.getAllByLabelText(s.secretValue) as HTMLInputElement[];
    expect(values[0]).toHaveAttribute('type', 'password');
    fireEvent.change(names[1] as HTMLElement, { target: { value: 'api-key' } });
    fireEvent.change(values[1] as HTMLElement, { target: { value: SECRET } });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', {
          name: /^Save: Set a secret Text messages/,
        })[0] as HTMLElement,
      );
    });
    await screen.findByText(s.secretSet('v-7'));
    const put = writes(seen)[0];
    expect(put?.path).toBe(`/api/v1/admin/integrations/${ID(51)}/secrets/api-key`);
    expect(put?.body).toEqual({ value: SECRET });
    expect((screen.getAllByLabelText(s.secretValue)[1] as HTMLInputElement).value).toBe('');
    expect(container.textContent).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it('clears the secret even when the save is refused, and does not echo it in the error', async () => {
    const SECRET = 'sk-live-another-secret';
    const { ui } = portal(
      '/admin/integrations',
      routes((x) =>
        x.method === 'PUT'
          ? problem(400, 'kernel.validation_failed', {
              errors: [{ path: '/value', code: 'kernel.invalid_format' }],
            })
          : undefined,
      ),
    );
    const { container } = render(ui);
    await screen.findAllByText('E-mail');
    fireEvent.change(screen.getAllByLabelText(s.secretName)[0] as HTMLElement, {
      target: { value: 'api-key' },
    });
    fireEvent.change(screen.getAllByLabelText(s.secretValue)[0] as HTMLElement, {
      target: { value: SECRET },
    });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: /^Save: Set a secret E-mail/ })[0] as HTMLElement,
      );
    });
    await screen.findByText(s.checkFields);
    expect((screen.getAllByLabelText(s.secretValue)[0] as HTMLInputElement).value).toBe('');
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it('refuses a malformed secret name before any call', async () => {
    const { ui, seen } = portal('/admin/integrations', routes());
    render(ui);
    await screen.findAllByText('E-mail');
    fireEvent.change(screen.getAllByLabelText(s.secretName)[0] as HTMLElement, {
      target: { value: 'Bad Name!' },
    });
    fireEvent.change(screen.getAllByLabelText(s.secretValue)[0] as HTMLElement, {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: /^Save: Set a secret E-mail/ })[0] as HTMLElement,
      );
    });
    expect(screen.getAllByText(s.secretNameInvalid).length).toBeGreaterThan(0);
    expect(writes(seen)).toHaveLength(0);
  });
});

describe('Flags and banners (AD-10)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/feature-flags'))
        return page([
          { id: ID(60), key: 'patient_messaging', locationId: null, enabled: false, rowVersion: 1 },
          { id: ID(61), key: 'waitlist_offers', locationId: ID(40), enabled: true, rowVersion: 2 },
        ]);
      if (x.method === 'GET' && x.path.endsWith('/locations')) return page([location(40)]);
      if (x.method === 'GET' && x.path.endsWith('/banners')) return page([]);
      return problem(404, 'kernel.not_found');
    };

  it('cannot turn patient messaging on: the button is off and the form says why', async () => {
    const { ui, seen } = portal('/admin/flags', routes());
    render(ui);
    await screen.findByText('patient_messaging');
    expect(screen.getByRole('button', { name: /^Turn on: patient_messaging/ })).toBeDisabled();
    expect(screen.getByText(s.messagingLocked)).toBeInTheDocument();
    type(s.flagKey, 'patient_messaging');
    expect((screen.getByRole('option', { name: s.flagOn }) as HTMLOptionElement).disabled).toBe(
      true,
    );
    expect(writes(seen)).toHaveLength(0);
  });

  it('shows the server refusal of patient messaging if it ever reaches the server', async () => {
    const { ui } = portal(
      '/admin/flags',
      routes((x) =>
        x.method === 'PUT'
          ? problem(400, 'kernel.validation_failed', {
              errors: [{ path: '/enabled', code: 'kernel.invalid_value' }],
            })
          : undefined,
      ),
    );
    render(ui);
    await screen.findByText('waitlist_offers');
    await click(/^Turn off: waitlist_offers/);
    expect(await screen.findByText(s.messagingRefused)).toBeInTheDocument();
  });

  it('turns a per-location flag off and removes it in-band', async () => {
    const { ui, seen } = portal(
      '/admin/flags',
      routes((x) =>
        x.method === 'PUT'
          ? json(200, { id: ID(61), key: 'waitlist_offers', enabled: false, rowVersion: 3 })
          : undefined,
      ),
    );
    render(ui);
    await screen.findByText('waitlist_offers');
    await click(/^Turn off: waitlist_offers/);
    await screen.findByText(s.saved);
    expect(writes(seen)[0]?.body).toEqual({
      key: 'waitlist_offers',
      locationId: ID(40),
      enabled: false,
    });
    await click(/^Remove: waitlist_offers/);
    await screen.findByText(s.removed);
    expect(writes(seen)[1]?.body).toEqual({
      key: 'waitlist_offers',
      locationId: ID(40),
      remove: true,
    });
  });

  it('refuses a banner with an e-mail address or a long number, and an end before the start', async () => {
    const { ui, seen } = portal('/admin/flags', routes());
    render(ui);
    await screen.findByText(s.bannersEmpty);
    await click(new RegExp(`^${s.add}: ${s.banners}`));
    type('Where it shows', 'site');
    type('Notice', 'Call me at jo@example.com');
    type('Starts', '2026-11-10T09:00');
    type('Ends', '2026-11-09T09:00');
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('form', { name: new RegExp(s.banners) })).getByRole('button', {
          name: s.save,
        }),
      );
    });
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getAllByText(new RegExp(s.bannerPhi)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(s.bannerOrder)).length).toBeGreaterThan(0);
  });
});

describe('Templates (AD-08)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/consent-templates'))
        return page([
          {
            id: ID(70),
            key: 'telehealth',
            version: 2,
            language: 'en',
            title: 'Telehealth consent',
            bodyText: 'Line one\n<b>not bold</b>',
            status: 'draft',
            rowVersion: 1,
          },
        ]);
      if (x.method === 'GET' && x.path.endsWith('/questionnaire-templates'))
        return page([
          {
            id: ID(72),
            key: 'intake',
            version: 1,
            schema: { red_flag_rules: [{ id: 'r1' }] },
            status: 'draft',
            approvedByNote: null,
            rowVersion: 1,
          },
        ]);
      return problem(404, 'kernel.not_found');
    };

  it('lists consent title and body as plain text, and creates with title and bodyText', async () => {
    const { ui, seen } = portal(
      '/admin/templates',
      routes((x) => (x.method === 'POST' ? json(201, { id: ID(73), status: 'draft' }) : undefined)),
    );
    render(ui);
    await screen.findByText('Telehealth consent');
    expect(screen.getByText(/<b>not bold<\/b>/)).toBeInTheDocument();
    await click(new RegExp(`^${s.add}: ${s.consent}`));
    type('Template key', 'photo');
    type('Language', 'en');
    type(s.consentTitle, 'Photo consent');
    type(s.consentBody, 'First line\nSecond line');
    await click(s.save);
    const w = writes(seen)[0];
    expect(w?.path).toBe('/api/v1/admin/consent-templates');
    expect(w?.body).toEqual({
      key: 'photo',
      language: 'en',
      title: 'Photo consent',
      bodyText: 'First line\nSecond line',
    });
  });

  it('publishes a consent draft with an empty body', async () => {
    const { ui, seen } = portal(
      '/admin/templates',
      routes((x) =>
        x.method === 'POST' ? json(200, { id: ID(70), status: 'published' }) : undefined,
      ),
    );
    render(ui);
    await screen.findByText('telehealth');
    await click(/^Publish: telehealth version 2/);
    await click(/^Publish telehealth version 2/);
    await screen.findByText(s.publishedNow);
    expect(writes(seen)[0]?.path).toBe(`/api/v1/admin/consent-templates/${ID(70)}/publish`);
    expect(writes(seen)[0]?.body).toEqual({});
  });

  it('needs the reviewer note to publish a questionnaire that has red-flag rules', async () => {
    const { ui, seen } = portal(
      '/admin/templates',
      routes((x) =>
        x.method === 'POST' ? json(200, { id: ID(72), status: 'published' }) : undefined,
      ),
    );
    render(ui);
    await screen.findByText('intake');
    await click(/^Publish: intake version 1/);
    await click(/^Publish intake version 1/);
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getByText(s.reviewerNoteShort)).toBeInTheDocument();
    type(s.reviewerNote, 'Reviewed by the clinical lead');
    await click(/^Publish intake version 1/);
    await screen.findByText(s.publishedNow);
    expect(writes(seen)[0]?.body).toEqual({ approvedByNote: 'Reviewed by the clinical lead' });
  });

  it('refuses a questionnaire definition that is not a JSON object', async () => {
    const { ui, seen } = portal('/admin/templates', routes());
    render(ui);
    await screen.findByText('intake');
    await click(new RegExp(`^${s.add}: ${s.questionnaires}`));
    type('Template key', 'intake');
    type(s.schemaLabel, '[1,2');
    await click(s.save);
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getAllByText(new RegExp(s.schemaInvalid)).length).toBeGreaterThan(0);
  });
});

describe('Vital ranges', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/vital-ranges'))
        return page([
          {
            id: ID(80),
            loincCode: '8867-4',
            unit: '/min',
            sex: 'any',
            ageYears: { from: 18 },
            low: 50,
            high: 100,
            status: 'active',
            approvedByNote: 'Reviewed by clinical lead',
          },
        ]);
      return problem(404, 'kernel.not_found');
    };

  it('says the table ships empty rather than inventing ranges', async () => {
    const { ui } = portal('/admin/vital-ranges', () => page([]));
    render(ui);
    expect(await screen.findByText(s.vitalsEmpty)).toBeInTheDocument();
  });

  it('adds a range with the reviewer note and retires one', async () => {
    const { ui, seen } = portal(
      '/admin/vital-ranges',
      routes((x) => (x.method === 'POST' ? json(200, {}) : undefined)),
    );
    render(ui);
    await screen.findByText('8867-4');
    expect(screen.getByText(s.bandText(18, null))).toBeInTheDocument();
    type(s.loinc, '8480-6');
    type(s.unit, 'mm[Hg]');
    type(s.ageFrom, '18');
    type(s.ageTo, '65');
    type(s.low, '90');
    type(s.high, '140');
    type(s.noteLabel, 'Approved by the clinical lead');
    await click(s.save);
    await screen.findByText(s.saved);
    expect(writes(seen)[0]?.body).toEqual({
      loincCode: '8480-6',
      unit: 'mm[Hg]',
      sex: 'any',
      ageYears: { from: 18, to: 65 },
      low: 90,
      high: 140,
      approvedByNote: 'Approved by the clinical lead',
    });
    await click(/^Retire: 8867-4/);
    await screen.findByText(s.retiredDone);
    expect(writes(seen)[1]?.path).toBe(`/api/v1/admin/vital-ranges/${ID(80)}/retire`);
  });

  it('checks bounds and the note before any call, and explains an overlap', async () => {
    const { ui, seen } = portal(
      '/admin/vital-ranges',
      routes((x) =>
        x.method === 'POST' ? problem(409, 'clinical.vital_range_overlap') : undefined,
      ),
    );
    render(ui);
    await screen.findByText('8867-4');
    type(s.loinc, '8480-6');
    type(s.unit, 'mm[Hg]');
    type(s.ageFrom, '18');
    type(s.low, '140');
    type(s.high, '90');
    type(s.noteLabel, 'short');
    await click(s.save);
    expect(writes(seen)).toHaveLength(0);
    expect(screen.getAllByText(new RegExp(s.boundsOrder)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(s.noteShort)).length).toBeGreaterThan(0);
    type(s.high, '160');
    type(s.noteLabel, 'Approved by the clinical lead');
    await click(s.save);
    expect(await screen.findByText(s.overlap)).toBeInTheDocument();
  });
});

describe('Elevation and failure states', () => {
  it('opens the security-key dialog before the first read when there is no grant', async () => {
    const { ui } = portal('/admin/services', () => page([service(1)]), { granted: false });
    render(ui);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a retry when the read fails, with the reference', async () => {
    const { ui } = portal('/admin/services', () => problem(503, 'kernel.unavailable'));
    render(ui);
    expect(await screen.findByText(/req-1/)).toBeInTheDocument();
  });

  it('keeps the form and says nothing was saved when offline', async () => {
    let n = 0;
    const { ui } = portal('/admin/policies', (x) => {
      if (x.method === 'GET' && x.path.endsWith('/booking-policies')) return page([]);
      if (x.method === 'GET' && x.path.endsWith('/services')) return page([service(30)]);
      if (x.method === 'GET') return page([]);
      n += 1;
      throw new TypeError('network');
    });
    render(ui);
    await screen.findByText(s.policiesEmpty);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: new RegExp(`^${s.add}`) })).toBeEnabled(),
    );
    await click(new RegExp(`^${s.add}`));
    type('Service', ID(30));
    await click(s.save);
    expect(await screen.findByText(s.offline)).toBeInTheDocument();
    expect(n).toBe(1);
  });
});

describe('Accessibility (axe, WCAG 2.2 AA, serious and critical)', () => {
  const all = (x: Seen): Response => {
    if (x.path.endsWith('/locations')) return page([location(40)]);
    if (x.path.endsWith('/services')) return page([service(30)]);
    if (x.path.endsWith('/booking-policies')) return page([policy(1)]);
    if (x.path.endsWith('/integrations')) return page([integration(50)]);
    if (x.path.endsWith('/feature-flags'))
      return page([
        { id: ID(60), key: 'waitlist_offers', locationId: null, enabled: true, rowVersion: 1 },
      ]);
    if (x.path.endsWith('/vital-ranges'))
      return page([
        {
          id: ID(80),
          loincCode: '8867-4',
          unit: '/min',
          sex: 'any',
          ageYears: { from: 18 },
          low: 50,
          high: 100,
          status: 'active',
        },
      ]);
    return page([]);
  };
  for (const [path, ready] of [
    ['/admin/clinics', 'Clinic 40'],
    ['/admin/services', 'Service 30'],
    ['/admin/policies', 'Service 30'],
    ['/admin/templates', s.templatesTitle],
    ['/admin/integrations', 'E-mail'],
    ['/admin/flags', 'waitlist_offers'],
    ['/admin/vital-ranges', '8867-4'],
  ] as const) {
    it(`has no serious violations on ${path}`, async () => {
      const { ui } = portal(path, all);
      const { container } = render(ui);
      await screen.findAllByText(ready);
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
      expect(await serious(container)).toEqual([]);
    });
  }
});
