// Unit tests (no database) for the notifications module: the allowlist and its copy in the migration, rendering for every
// channel, the PHI scan, the structural "cannot be saved" rules, the RA-R1-05 render-every-template check, the preference
// rule (TC-NT-08), quiet hours, and the byte-parity of the files shared with the worker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_VALUES,
  VARIABLE_ALLOWLIST,
  isAllowedVariable,
  normaliseValue,
} from './allowlist.js';
import { findForbidden } from './forbidden.js';
import { NOTIFICATIONS_JOBS } from './jobs.js';
import { parseRecipientRef, applyCommunicationPreferences, quietHoursEnd } from './recipient.js';
import { RenderError, renderTemplate } from './render.js';
import { R1_TEMPLATE_KEYS, r1TemplatesForLanguages } from './r1-templates.js';
import { evaluateVersion, structuralFailures, type TemplateView } from './templates.js';

let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const migration = readFileSync(
  `${root}db/migrations/0600_notifications_schema_and_tables.sql`,
  'utf8',
);

const asViews = (rows: ReturnType<typeof r1TemplatesForLanguages>): TemplateView[] =>
  rows.map((r, i) => ({
    id: String(i),
    key: r.key,
    channel: r.channel,
    language: r.language,
    version: 1,
    subject: r.subject ?? null,
    body: r.body,
    variables: [...r.variables],
    status: 'draft',
    renderCheckPassedAt: null,
    publishedAt: null,
  }));

describe('the allowlist (BD-10)', () => {
  test('names no service, diagnosis, medicine, test or clinician field', () => {
    for (const n of Object.keys(VARIABLE_ALLOWLIST))
      assert.doesNotMatch(n, /service|diagnos|medic|drug|clinician|doctor|provider|note|reason/i);
    assert.equal(isAllowedVariable('service_name', 'location_name'), false);
    assert.equal(isAllowedVariable('clinician_name', 'location_name'), false);
    assert.equal(isAllowedVariable('diagnosis', 'location_name'), false);
    assert.equal(isAllowedVariable('medicine', 'code'), false);
    assert.equal(isAllowedVariable('start_at', 'url'), false);
    assert.equal(isAllowedVariable('constructor', 'datetime'), false);
    assert.equal(isAllowedVariable('__proto__', 'datetime'), false);
  });

  test('the migration lists exactly the same (name, type) pairs and value names', () => {
    const fn = /allowed_variable[\s\S]*?IN \(([\s\S]*?)\)\s*\$\$/.exec(migration)?.[1] ?? '';
    const pairs = [...fn.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    const code = Object.entries(VARIABLE_ALLOWLIST)
      .map(([n, t]) => `${n}:${t}`)
      .sort();
    assert.deepEqual(pairs, code);
    const values = /VALUES (\([\s\S]*?\)) AS a\(n\)/.exec(migration)?.[1] ?? '';
    const names = [...values.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(names, Object.keys(VARIABLE_ALLOWLIST).sort());
  });

  test('values are checked per type', () => {
    assert.equal(normaliseValue('datetime', '2030-01-15T14:30:00Z'), '2030-01-15T14:30:00.000Z');
    assert.equal(normaliseValue('datetime', '2030-02-31T14:30:00Z'), undefined);
    assert.equal(normaliseValue('datetime', 'next tuesday'), undefined);
    assert.equal(
      normaliseValue('url', 'https://portal.example.test/a?b=c'),
      'https://portal.example.test/a?b=c',
    );
    assert.equal(normaliseValue('url', 'http://portal.example.test/'), undefined);
    assert.equal(normaliseValue('url', 'https://user:pw@portal.example.test/'), undefined);
    assert.equal(normaliseValue('url', 'javascript:alert(1)'), undefined);
    assert.equal(
      normaliseValue('url', 'https://evil.test/', { allowedLinkHosts: ['portal.example.test'] }),
      undefined,
    );
    assert.equal(normaliseValue('code', 'A1B2C3'), 'A1B2C3');
    assert.equal(normaliseValue('code', 'A1 B2'), undefined);
    assert.equal(normaliseValue('timezone', 'America/New_York'), 'America/New_York');
    assert.equal(normaliseValue('timezone', 'Mars/Base'), undefined);
    assert.equal(
      normaliseValue('uid', '00000000-0000-4000-8000-000000000001'),
      '00000000-0000-4000-8000-000000000001',
    );
    assert.equal(normaliseValue('location_name', 'Riverside Clinic'), 'Riverside Clinic');
    assert.equal(normaliseValue('location_name', '<script>'), undefined);
    assert.equal(normaliseValue('location_name', 'a\nb'), undefined);
    assert.equal(normaliseValue('location_name', 'x'.repeat(81)), undefined);
    assert.equal(normaliseValue('datetime', 42), undefined);
  });
});

describe('PHI scan', () => {
  test('flags condition-revealing text by rule name, never echoing it', () => {
    for (const t of [
      'Your HIV test result is ready',
      'Refill your prescription',
      'Appointment with Dr. Smith',
      'diagnosis update',
      'oncology visit',
      'Your blood test',
    ]) {
      const f = findForbidden(t);
      assert.ok(f.length > 0, t);
      assert.equal(JSON.stringify(f).includes('HIV'), false);
    }
    assert.deepEqual(
      findForbidden('Sign in to your patient portal: https://portal.example.test/appointments'),
      [],
    );
    assert.deepEqual(findForbidden('Your appointment is on Jan 15, 2030, 2:30 PM. Sign in.'), []);
    assert.ok(findForbidden('Visit the Sunrise Fertility Wing', ['sunrise']).length > 0);
    assert.deepEqual(findForbidden('Hello', ['hello'.slice(0, 2)]), []);
  });
});

describe('rendering', () => {
  const base = {
    language: 'en',
    subject: null,
    declared: ['start_at', 'time_zone', 'location_name', 'portal_link'],
  };
  const vals = {
    start_at: '2030-01-15T14:30:00.000Z',
    time_zone: 'America/New_York',
    location_name: 'Riverside Clinic',
    portal_link: 'https://portal.example.test/x',
  };

  test('substitutes declared placeholders, formats times in the given zone, and refuses anything else', () => {
    const r = renderTemplate(
      { ...base, channel: 'sms', body: 'At {{start_at}} {{ location_name }}: {{portal_link}}' },
      vals,
    );
    assert.match(
      r.body,
      /^At Jan 15, 2030, 9:30\s?AM Riverside Clinic: https:\/\/portal\.example\.test\/x$/,
    );
    assert.throws(
      () => renderTemplate({ ...base, channel: 'sms', body: '{{code}}' }, vals),
      (e: RenderError) => e.rule === 'undeclared_variable',
    );
    assert.throws(
      () => renderTemplate({ ...base, declared: ['code'], channel: 'sms', body: '{{code}}' }, vals),
      (e: RenderError) => e.rule === 'missing_variable',
    );
  });

  test('a value cannot break out of a subject or an SMS line, or of an .ics line', () => {
    const evil = { ...vals, location_name: 'Clinic' };
    const mail = renderTemplate(
      { ...base, channel: 'email', subject: 'At {{location_name}}', body: 'x' },
      evil,
    );
    assert.equal(/[\r\n]/.test(mail.subject ?? ''), false);
    const ics = renderTemplate(
      {
        ...base,
        declared: ['start_at', 'end_at', 'location_name', 'event_uid'],
        channel: 'ics',
        body: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:{{event_uid}}\nDTSTART:{{start_at}}\nDTEND:{{end_at}}\nLOCATION:{{location_name}}\nEND:VEVENT\nEND:VCALENDAR\n',
      },
      {
        ...evil,
        end_at: '2030-01-15T15:00:00.000Z',
        event_uid: SAMPLE_VALUES.uid,
        location_name: 'Wing A, Floor 2; Room 3',
      },
    );
    assert.match(ics.body, /DTSTART:20300115T143000Z\r\n/);
    assert.match(ics.body, /LOCATION:Wing A\\, Floor 2\\; Room 3\r\n/);
    assert.match(ics.body, /\r\n$/);
    for (const line of ics.body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  });

  test('an .ics body without the calendar structure is refused', () => {
    assert.throws(
      () => renderTemplate({ ...base, channel: 'ics', body: 'hello' }, vals),
      (e: RenderError) => e.rule === 'ics_structure',
    );
  });

  test('long .ics lines are folded at 75 octets without splitting a character', () => {
    const body = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDESCRIPTION:${'é'.repeat(100)}\nEND:VEVENT\nEND:VCALENDAR\n`;
    const out = renderTemplate({ ...base, declared: [], channel: 'ics', body }, {}).body;
    for (const line of out.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
    assert.equal(out.replace(/\r\n /g, '').includes('é'.repeat(100)), true);
  });
});

describe('what cannot be saved (structure)', () => {
  test('a template binding a service, diagnosis, medicine or clinician name is refused', () => {
    for (const name of [
      'service_name',
      'diagnosis',
      'medicine_name',
      'clinician_name',
      'service_display_name',
    ])
      assert.deepEqual(
        structuralFailures({
          body: `Hello {{${name}}}`,
          variables: [{ name, type: 'location_name' }],
        })
          .map((f) => f.rule)
          .sort(),
        ['variable_not_allowed'],
        name,
      );
    assert.deepEqual(
      structuralFailures({ body: 'Hello {{service_name}}', variables: [] }).map((f) => f.rule),
      ['variable_not_allowed'],
    );
  });
  test('an undeclared placeholder, a malformed brace and a duplicate declaration are refused', () => {
    assert.deepEqual(
      structuralFailures({ body: '{{portal_link}}', variables: [] }).map((f) => f.rule),
      ['placeholder_not_declared'],
    );
    assert.ok(
      structuralFailures({
        body: '{{ portal_link',
        variables: [{ name: 'portal_link', type: 'url' }],
      }).some((f) => f.rule === 'placeholder_malformed'),
    );
    assert.ok(
      structuralFailures({
        body: 'x',
        variables: [
          { name: 'code', type: 'code' },
          { name: 'code', type: 'code' },
        ],
      }).some((f) => f.rule === 'variable_duplicate'),
    );
    assert.deepEqual(
      structuralFailures({
        body: '{{portal_link}}',
        variables: [{ name: 'portal_link', type: 'url' }],
      }),
      [],
    );
  });
});

describe('render every template, every language, every channel (RA-R1-05, TC-NT-01)', () => {
  const LANGS = ['en', 'es', 'fr'];

  test('the R1 set renders and is free of condition-revealing text in all configured languages', () => {
    const rows = r1TemplatesForLanguages(LANGS);
    const keys = new Set(rows.map((r) => r.key));
    assert.deepEqual([...keys].sort(), [...R1_TEMPLATE_KEYS].sort());
    assert.equal(keys.size, 8);
    let rendered = 0;
    for (const key of keys) {
      const failures = evaluateVersion(asViews(rows.filter((r) => r.key === key)), LANGS);
      assert.deepEqual(failures, [], key);
    }
    // And independently of evaluateVersion: render each row with the sample values and scan the output.
    for (const r of rows) {
      const values: Record<string, string> = {};
      for (const v of r.variables) values[v.name] = SAMPLE_VALUES[v.type];
      const out = renderTemplate(
        {
          channel: r.channel,
          language: r.language,
          subject: r.subject ?? null,
          body: r.body,
          declared: r.variables.map((v) => v.name),
        },
        values,
      );
      assert.deepEqual(
        findForbidden(`${out.subject ?? ''}\n${out.body}`),
        [],
        `${r.key}/${r.channel}/${r.language}`,
      );
      rendered += 1;
    }
    assert.equal(rendered, rows.length);
    assert.ok(
      rows.some((r) => r.channel === 'ics') &&
        rows.some((r) => r.channel === 'sms') &&
        rows.some((r) => r.channel === 'push') &&
        rows.some((r) => r.channel === 'email'),
    );
  });

  test('a configured language with no row, a leaking text and a hidden clinician name each fail the check', () => {
    const rows = r1TemplatesForLanguages(['en']).filter(
      (r) => r.key === 'appointment_confirmation',
    );
    assert.deepEqual(evaluateVersion(asViews(rows), ['en']), []);
    const missing = evaluateVersion(asViews(rows), ['en', 'de']);
    assert.ok(missing.some((f) => f.rule === 'language_missing' && f.language === 'de'));

    const leaky = asViews(rows).map((r) =>
      r.channel === 'sms' ? { ...r, body: 'Your HIV test result is ready: {{portal_link}}' } : r,
    );
    assert.ok(
      evaluateVersion(leaky, ['en']).some(
        (f) => f.rule.startsWith('forbidden_text:') && f.channel === 'sms',
      ),
    );

    const clinician = asViews(rows).map((r) =>
      r.channel === 'push' ? { ...r, body: 'Appointment with Dr. Jones on {{start_at}}' } : r,
    );
    assert.ok(
      evaluateVersion(clinician, ['en']).some((f) => f.rule === 'forbidden_text:clinician_name'),
    );

    const tooLong = asViews(rows).map((r) =>
      r.channel === 'push' ? { ...r, body: 'x'.repeat(200) } : r,
    );
    assert.ok(evaluateVersion(tooLong, ['en']).some((f) => f.rule === 'too_long'));

    const deployment = evaluateVersion(asViews(rows), ['en'], ['patient portal']);
    assert.ok(deployment.some((f) => f.rule === 'forbidden_text:deployment_term'));
    assert.deepEqual(evaluateVersion([], ['en']), [{ rule: 'version_empty' }]);
  });
});

describe('recipient reference and preferences (rule 7, TC-NT-08)', () => {
  test('a recipient reference is a kind and an ID, never an address', () => {
    assert.deepEqual(parseRecipientRef('patient:00000000-0000-7000-8000-0000000000d1'), {
      kind: 'patient',
      id: '00000000-0000-7000-8000-0000000000d1',
    });
    assert.equal(parseRecipientRef('person@example.test'), undefined);
    assert.equal(parseRecipientRef('patient:+15550100'), undefined);
    assert.equal(parseRecipientRef('thing:00000000-0000-7000-8000-0000000000d1'), undefined);
  });

  test('SMS off and e-mail on: no SMS channel is permitted, e-mail and in-app are; no address -> withheld; reminder channel narrows reminders', () => {
    const contacts = { email: 'a@example.test', phone: '+15550100', push: 'sub-1' };
    const r = applyCommunicationPreferences(contacts, { channels: ['email'], language: 'en' });
    assert.deepEqual(r.permitted.map((p) => p.channel).sort(), ['email', 'in_app']);
    assert.deepEqual(
      r.withheld.find((w) => w.channel === 'sms'),
      { channel: 'sms', reason: 'preference_off' },
    );
    const none = applyCommunicationPreferences(
      { email: 'a@example.test' },
      { channels: ['email', 'sms'], language: 'en' },
    );
    assert.deepEqual(none.withheld, [
      { channel: 'sms', reason: 'no_address' },
      { channel: 'push', reason: 'preference_off' },
    ]);
    const rem = applyCommunicationPreferences(
      contacts,
      { channels: ['email', 'sms'], reminderChannel: 'sms', language: 'en' },
      'reminder',
    );
    assert.deepEqual(rem.permitted.map((p) => p.channel).sort(), ['in_app', 'sms']);
  });

  test('quiet hours: inside the window gives its end, outside gives nothing, across midnight and zones', () => {
    const q = { start: '22:00', end: '07:00', timeZone: 'America/New_York' };
    // 03:00 UTC on 2030-01-16 is 22:00 the evening before in New York (UTC-5).
    assert.equal(
      quietHoursEnd(q, new Date('2030-01-16T03:00:00Z'))?.toISOString(),
      '2030-01-16T12:00:00.000Z',
    );
    assert.equal(quietHoursEnd(q, new Date('2030-01-16T17:00:00Z')), undefined);
    assert.equal(quietHoursEnd({ ...q, start: '25:00' }, new Date()), undefined);
    assert.equal(quietHoursEnd({ ...q, timeZone: 'Mars/Base' }, new Date()), undefined);
  });
});

describe('the worker keeps in step', () => {
  const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
  test('shared pure files are byte-identical in apps/api and apps/worker', () => {
    for (const f of ['allowlist', 'forbidden', 'render', 'recipient', 'ids'])
      assert.equal(
        sha(`${root}apps/api/src/modules/notifications/${f}.ts`),
        sha(`${root}apps/worker/src/jobs/notifications/${f}.ts`),
        f,
      );
  });
  test('job lists are the same on both sides', () => {
    const w = readFileSync(`${root}apps/worker/src/jobs/notifications/jobs.ts`, 'utf8');
    const names = [...w.matchAll(/name: '([a-z_.]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      names,
      NOTIFICATIONS_JOBS.map((j) => j.name),
    );
    for (const j of NOTIFICATIONS_JOBS) {
      assert.ok(w.includes(`maxAttempts: ${j.maxAttempts}`));
      assert.ok(w.includes(`onMerged: '${j.onMerged}'`));
      assert.ok(w.includes(`jobScope: '${j.jobScope}'`));
    }
    assert.deepEqual(
      NOTIFICATIONS_JOBS.filter((j) => j.carriesPatientIds).map((j) => j.onMerged),
      ['resolve'],
    );
  });
});
