/* eslint-disable boundaries/module-boundaries -- test: acceptance item 5 needs the clinical consent gate and the patient kit's template port; same exemption as the flow kit */
// Real-database tests of the patient's required-consents list and the route that opens them (HEAAA-296 D1, D2; ticket HEAAA-300).
// PostgreSQL 17 with RLS forced, the real Nest application and guard; synthetic data and placeholder consent wording only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/previsit-consents.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { publishedTemplates, tpl } from '../../patient/testkit.js';
import { ConsentGateService } from '../../clinical/frontdoor/index.js';
import {
  ORG,
  SVC,
  SVC2,
  call,
  saWrite,
  seedPrincipal,
  seedSession,
  setupFlow,
  writeHeaders,
} from './testkit.js';
import type { FlowKit, PatientKit } from './testkit.js';

let t: FlowKit;
before(async () => {
  t = await setupFlow('pc');
  // placeholder wording (test data, C-03 style): two templates required by SVC; SVC2 requires none
  await t.k.sa.query(
    `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status) VALUES
       ($1, $5, 'privacy', 1, 'en', 'Privacy notice', 'PLACEHOLDER privacy wording, version 1 (test data).', 'published'),
       ($2, $5, 'privacy', 1, 'fr', 'Avis de confidentialité', 'TEXTE PROVISOIRE confidentialité, version 1 (données de test).', 'published'),
       ($3, $5, 'treatment', 1, 'en', 'Treatment consent', 'PLACEHOLDER treatment wording, version 1 (test data).', 'published'),
       ($4, $5, 'treatment', 1, 'de', 'Behandlung', 'PLATZHALTER Behandlung (Testdaten).', 'published')`,
    [randomUUID(), randomUUID(), randomUUID(), randomUUID(), ORG],
  );
  // the patient kit's template port is a set (the organisation module owns the real rows): keep it equal to the rows above
  for (const [k, v] of [
    ['privacy', 1],
    ['treatment', 1],
  ] as const)
    publishedTemplates.add(tpl(k, v));
  await t.k.sa.query(
    `INSERT INTO organisation.service_required_consent (organisation_id, service_id, consent_template_key) VALUES ($1, $2, 'privacy'), ($1, $2, 'treatment')`,
    [ORG, SVC],
  );
});
after(async () => {
  await t?.close();
});

const NOW = new Date('2031-03-04T15:00:00.000Z');
const APPT = new Date('2031-03-04T15:30:00.000Z');
const meta = () => ({ requestId: randomUUID() });
const HOST = 'my.example.test';
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const count = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await q<{ n: string }>(sql, p))[0]?.n);
const consentRows = (patientId: string) =>
  count(`SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1`, [patientId]);
const auditRows = () => count(`SELECT count(*) AS n FROM audit.event`);

async function visit(n: number, status = 'confirmed', serviceId = SVC) {
  const p = await t.patient(n);
  const doc = (await t.doctor()).principalId;
  const rid = await t.seed(p, doc, APPT, { status, serviceId });
  return { p, rid };
}
const get = (who: { session: { cookie: string } }, rid: string) =>
  call(t.k.base, 'GET', `/api/v1/appointments/${rid}/previsit`, {
    host: HOST,
    cookie: who.session.cookie,
  });
const post = (
  who: PatientKit,
  rid: string,
  key: string = randomUUID(),
  body: unknown = undefined,
) =>
  call(t.k.base, 'POST', `/api/v1/appointments/${rid}/previsit/consents`, {
    host: HOST,
    cookie: who.session.cookie,
    headers: writeHeaders(who.session, HOST, key),
    ...(body === undefined ? {} : { body }),
  });
type Item = {
  id: string | null;
  templateKey: string;
  templateVersion: number;
  language: string;
  title: string | null;
  text: string | null;
  status: string;
};
const itemsOf = (body: Record<string, unknown>): Item[] => body['requiredConsents'] as Item[];
const byKey = (items: Item[]) => Object.fromEntries(items.map((i) => [i.templateKey, i]));
const sign = (p: PatientKit, consentId: string) =>
  t.as(p.scope, (tx) =>
    t.k.patient.records.signConsent(tx, meta(), consentId, { typedName: 'Pat Ient' }),
  );

describe('GET /appointments/{id}/previsit: requiredConsents (HEAAA-296 D1)', () => {
  test('two required templates: missing, pending (with id), signed and outdated; consents is all-signed; the read writes nothing', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(601);
    const before = { c: await consentRows(p.patientId), a: await auditRows() };

    const r0 = await get(p, rid);
    assert.equal(r0.status, 200, r0.body);
    assert.equal(r0.headers['cache-control'], 'no-store');
    const b0 = r0.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(b0).sort(), [
      'consents',
      'insurance',
      'questionnaire',
      'requiredConsents',
      'reservationId',
    ]);
    assert.deepEqual(
      itemsOf(b0).map((i) => [i.templateKey, i.status, i.id, i.templateVersion, i.language]),
      [
        ['privacy', 'missing', null, 1, 'en'],
        ['treatment', 'missing', null, 1, 'en'],
      ],
      'sorted by key, one item per template, en when the patient has no preference',
    );
    assert.equal(itemsOf(b0)[0]?.title, 'Privacy notice');
    assert.equal(itemsOf(b0)[0]?.text, 'PLACEHOLDER privacy wording, version 1 (test data).');
    assert.equal(b0['consents'], false);

    // a pending row for privacy; a signed v1 of treatment which then becomes outdated by a v2
    const pending = await t.as(p.scope, (tx) =>
      t.k.patient.records.requestConsent(tx, meta(), p.patientId, 'privacy', 1),
    );
    const tr = await t.as(p.scope, (tx) =>
      t.k.patient.records.requestConsent(tx, meta(), p.patientId, 'treatment', 1),
    );
    await sign(p, tr.id);
    const b1 = (await get(p, rid)).json() as Record<string, unknown>;
    assert.deepEqual(
      itemsOf(b1).map((i) => [i.templateKey, i.status, i.id]),
      [
        ['privacy', 'pending', pending.id],
        ['treatment', 'signed', null],
      ],
    );
    assert.equal(b1['consents'], false);

    await t.k.sa.query(
      `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
       VALUES ($1, $2, 'treatment', 2, 'en', 'Treatment consent', 'PLACEHOLDER treatment wording, version 2 (test data).', 'published')`,
      [randomUUID(), ORG],
    );
    publishedTemplates.add(tpl('treatment', 2));
    const b2 = (await get(p, rid)).json() as Record<string, unknown>;
    const k2 = byKey(itemsOf(b2));
    assert.equal(k2['treatment']?.status, 'outdated');
    assert.equal(k2['treatment']?.templateVersion, 2);
    assert.equal(k2['treatment']?.id, null, 'id only for a pending row');
    assert.equal(b2['consents'], false);

    // every item signed: consents is true
    await sign(p, pending.id);
    const tr2 = await t.as(p.scope, (tx) =>
      t.k.patient.records.requestConsent(tx, meta(), p.patientId, 'treatment', 2),
    );
    await sign(p, tr2.id);
    const b3 = (await get(p, rid)).json() as Record<string, unknown>;
    assert.deepEqual(
      itemsOf(b3).map((i) => i.status),
      ['signed', 'signed'],
    );
    assert.equal(b3['consents'], true);

    // a read writes nothing: count a fresh patient before and after a burst of GETs
    const q1 = await visit(602);
    const c1 = { c: await consentRows(q1.p.patientId), a: await auditRows() };
    await get(q1.p, q1.rid);
    await get(q1.p, q1.rid);
    assert.deepEqual({ c: await consentRows(q1.p.patientId), a: await auditRows() }, c1);
    assert.equal(c1.c, 0);
    assert.equal(before.c, 0);
  });

  test("the language is the patient's preferred one, else en, else the lowest; a reservation of a service with no required consent gets []", async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(603);
    await q(`UPDATE patient.patient SET preferred_language = 'fr' WHERE id = $1`, [p.patientId]);
    const items = itemsOf((await get(p, rid)).json() as Record<string, unknown>);
    const k = byKey(items);
    assert.equal(k['privacy']?.language, 'fr');
    assert.equal(k['privacy']?.title, 'Avis de confidentialité');
    assert.equal(k['treatment']?.language, 'en', 'no fr text: en');
    await q(`UPDATE patient.patient SET preferred_language = 'it' WHERE id = $1`, [p.patientId]);
    assert.equal(
      byKey(itemsOf((await get(p, rid)).json() as Record<string, unknown>))['privacy']?.language,
      'en',
    );
    const none = await visit(604, 'confirmed', SVC2);
    const b = (await get(none.p, none.rid)).json() as Record<string, unknown>;
    assert.deepEqual(b['requiredConsents'], []);
    assert.equal(b['consents'], true);
  });

  test('a proxy gets requiredConsents null (200); another patient gets 404', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(605);
    const proxy = await proxyOf(p.patientId, 'Proxy 605');
    const r = await get(proxy, rid);
    assert.equal(r.status, 200, r.body);
    assert.equal((r.json() as Record<string, unknown>)['requiredConsents'], null);
    const stranger = await t.bare(606);
    assert.equal((await get(stranger, rid)).status, 404);
    assert.equal((await get({ session: { cookie: 'x' } }, rid)).status, 401);
  });
});

async function proxyOf(patientId: string, name: string): Promise<PatientKit> {
  const pr = await seedPrincipal(t.k, 'patient_pool', { name });
  await saWrite(
    t.k,
    `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, verified_by)
     VALUES ($1, $2, $3, $4, 'parent', 'Sam J', 'active', $3)`,
    [randomUUID(), ORG, pr.principalId, patientId],
  );
  return {
    patientId,
    session: await seedSession(t.k, pr, 'patient_pool'),
    scope: {
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: pr.principalId,
      personId: pr.personId,
      patientIds: [patientId],
      proxyPatientIds: [patientId],
    },
  };
}

describe('POST /appointments/{id}/previsit/consents (HEAAA-296 D2)', () => {
  test('opens pending rows only for missing/outdated; a replay returns the same body; a new key adds nothing; the audit has one create per row', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(611);
    const key = randomUUID();
    const auditBefore = await auditRows();
    const r1 = await post(p, rid, key);
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r1.headers['cache-control'], 'no-store');
    const b1 = r1.json() as Record<string, unknown>;
    const items = itemsOf(b1);
    assert.deepEqual(
      items.map((i) => [i.templateKey, i.status]),
      [
        ['privacy', 'pending'],
        ['treatment', 'pending'],
      ],
    );
    assert.ok(items.every((i) => typeof i.id === 'string'));
    assert.equal(await consentRows(p.patientId), 2);
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'patient.consent' AND action = 'create' AND patient_id = $1`,
        [p.patientId],
      ),
      2,
    );
    assert.ok((await auditRows()) >= auditBefore + 2);

    const replay = await post(p, rid, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['idempotent-replay'], 'true');
    assert.deepEqual(replay.json(), b1);

    const again = await post(p, rid, randomUUID());
    assert.equal(again.status, 200);
    assert.deepEqual(
      itemsOf(again.json() as Record<string, unknown>).map((i) => i.id),
      items.map((i) => i.id),
      'the same pending rows',
    );
    assert.equal(await consentRows(p.patientId), 2);
    // the body of the POST is the GET body
    assert.deepEqual(again.json(), (await get(p, rid)).json());

    // a signed item is left alone; only the other one is touched when a newer version appears
    await sign(p, items[0]?.id as string);
    await t.k.sa.query(
      `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
       VALUES ($1, $2, 'privacy', 2, 'en', 'Privacy notice', 'PLACEHOLDER privacy wording, version 2 (test data).', 'published')`,
      [randomUUID(), ORG],
    );
    publishedTemplates.add(tpl('privacy', 2));
    const b = byKey(itemsOf((await get(p, rid)).json() as Record<string, unknown>));
    assert.equal(b['privacy']?.status, 'outdated');
    const r3 = await post(p, rid);
    const k3 = byKey(itemsOf(r3.json() as Record<string, unknown>));
    assert.equal(k3['privacy']?.status, 'pending');
    assert.equal(k3['privacy']?.templateVersion, 2);
    assert.equal(k3['treatment']?.id, items[1]?.id, 'the open treatment row is untouched');
    assert.equal(await consentRows(p.patientId), 3);
  });

  test('concurrent calls create exactly one pending row per template version', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(612);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.as(p.scope, (tx) => t.flow.openPrevisitConsents(tx, meta(), rid)),
      ),
    );
    assert.equal(await consentRows(p.patientId), 2);
    const ids = new Set(results.flatMap((r) => (r.requiredConsents ?? []).map((i) => i.id)));
    assert.equal(ids.size, 2);
    assert.ok(results.every((r) => r.requiredConsents?.every((i) => i.status === 'pending')));
    const http = await Promise.all(Array.from({ length: 4 }, () => post(p, rid)));
    assert.ok(http.every((r) => r.status === 200));
    assert.equal(await consentRows(p.patientId), 2);
  });

  test('the returned id signs; the GET then shows signed and the consultation gate no longer lists the key', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(613);
    const gate = new ConsentGateService({
      audit: {} as never,
      catalog: { requiredConsents: (tx, sid) => t.org.consentTemplatesRequired(tx, sid) },
      consents: {
        status: (tx, pid, tpl) => t.k.patient.records.requiredConsentStatus(tx, pid, tpl),
      },
    });
    const missing = () => t.as(p.scope, (tx) => gate.missing(tx, p.patientId, SVC));
    assert.deepEqual(await missing(), ['privacy', 'treatment']);
    const items = itemsOf((await post(p, rid)).json() as Record<string, unknown>);
    assert.deepEqual(await missing(), ['privacy', 'treatment'], 'pending is not signed');
    const privacy = items.find((i) => i.templateKey === 'privacy') as Item;
    const s = await call(t.k.base, 'POST', `/api/v1/consents/${privacy.id}/sign`, {
      host: HOST,
      cookie: p.session.cookie,
      headers: writeHeaders(p.session, HOST, randomUUID()),
      body: { typedName: 'Pat Ient' },
    });
    assert.equal(s.status, 200, s.body);
    const after = byKey(itemsOf((await get(p, rid)).json() as Record<string, unknown>));
    assert.equal(after['privacy']?.status, 'signed');
    assert.equal(after['privacy']?.id, null);
    assert.deepEqual(await missing(), ['treatment']);
  });

  test('a proxy gets 403 auth.forbidden and nothing is written; another patient gets 404; a cancelled reservation gets 404; checked in is allowed', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(614);
    const proxy = await proxyOf(p.patientId, 'Proxy 614');
    const forbidden = await post(proxy, rid);
    assert.equal(forbidden.status, 403, forbidden.body);
    assert.equal((forbidden.json() as { code: string }).code, 'auth.forbidden');
    assert.equal(await consentRows(p.patientId), 0);

    const stranger = await t.bare(615);
    assert.equal((await post(stranger, rid)).status, 404);
    assert.equal(await consentRows(p.patientId), 0);
    assert.equal((await post(p, randomUUID())).status, 404, 'a reservation that does not exist');

    const cancelled = await visit(616, 'cancelled_patient');
    const c = await post(cancelled.p, cancelled.rid);
    assert.equal(c.status, 404);
    assert.equal(await consentRows(cancelled.p.patientId), 0);
    const nostate = await get(cancelled.p, cancelled.rid);
    assert.equal(nostate.status, 200, 'the read stays available');

    const here = await visit(617, 'checked_in');
    assert.equal((await post(here.p, here.rid)).status, 200);
    assert.equal(await consentRows(here.p.patientId), 2);
  });

  test('validation: the idempotency key is required, a body with any field is refused, an empty object is accepted; a bad id is 404', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(618);
    const noKey = await call(t.k.base, 'POST', `/api/v1/appointments/${rid}/previsit/consents`, {
      host: HOST,
      cookie: p.session.cookie,
      headers: writeHeaders(p.session, HOST),
    });
    assert.equal(noKey.status, 400);
    assert.equal((noKey.json() as { code: string }).code, 'kernel.idempotency_key_required');
    const extra = await post(p, rid, randomUUID(), { templateKey: 'privacy' });
    assert.equal(extra.status, 422);
    assert.equal((extra.json() as { code: string }).code, 'kernel.validation_failed');
    assert.equal(await consentRows(p.patientId), 0);
    assert.equal((await post(p, rid, randomUUID(), {})).status, 200);
    assert.equal((await post(p, 'not-a-uuid')).status, 404);
  });
});
