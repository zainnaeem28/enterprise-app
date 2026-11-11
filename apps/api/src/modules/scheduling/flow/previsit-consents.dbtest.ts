/* eslint-disable boundaries/module-boundaries -- test: acceptance item 5 needs the clinical consent gate and the patient kit's template port; same exemption as the flow kit */
// Real-database tests of the patient's required-consents list and the route that opens them (HEAAA-296 rev 6 D1, D2, D3; ticket HEAAA-305).
// PostgreSQL 17 with RLS forced, the real Nest application and guard, the real `app_api` role; synthetic data and placeholder wording only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/previsit-consents.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { publishedTemplates, tpl } from '../../patient/testkit.js';
import { ConsentGateService } from '../../clinical/frontdoor/index.js';
import {
  ORG,
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
});
after(async () => {
  await t?.close();
});

const NOW = new Date('2031-03-04T15:00:00.000Z');
const APPT = new Date('2031-03-04T15:30:00.000Z');
const APPT2 = new Date('2031-03-05T15:30:00.000Z');
const meta = () => ({ requestId: randomUUID() });
const HOST = 'my.example.test';
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const count = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await q<{ n: string }>(sql, p))[0]?.n);
const consentRows = (patientId: string) =>
  count(`SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1`, [patientId]);
const auditRows = () => count(`SELECT count(*) AS n FROM audit.event`);
const auditFor = (patientId: string, action: string) =>
  count(
    `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'patient.consent' AND action = $2 AND patient_id = $1`,
    [patientId, action],
  );

let svcSeq = 0x5100;
/** A fresh service that requires exactly these template keys, so a scenario never disturbs another. */
async function service(keys: string[]): Promise<string> {
  const id = `00000000-0000-7000-8000-00000000${(svcSeq++).toString(16).padStart(4, '0')}`;
  await t.k.sa.query(
    `INSERT INTO organisation.service (id, organisation_id, internal_name, patient_display_name, duration_min, buffer_min, mode, active)
     VALUES ($1, $2, $3, 'Appointment', 30, 0, 'either', true)`,
    [id, ORG, `Consent test ${id}`],
  );
  for (const key of keys)
    await t.k.sa.query(
      `INSERT INTO organisation.service_required_consent (organisation_id, service_id, consent_template_key) VALUES ($1, $2, $3)`,
      [ORG, id, key],
    );
  return id;
}
/** A consent template row with placeholder wording (O-2: test data, not client text). */
async function template(
  key: string,
  version: number,
  language: string,
  status: 'published' | 'draft' | 'retired' = 'published',
): Promise<void> {
  const initial = status === 'retired' ? 'published' : status;
  await t.k.sa.query(
    `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      ORG,
      key,
      version,
      language,
      `[PLACEHOLDER title ${key} v${version} ${language}]`,
      `[PLACEHOLDER consent wording ${key} v${version} ${language}, not client text]`,
      initial,
    ],
  );
  if (initial === 'published') publishedTemplates.add(tpl(key, version, language));
  if (status === 'retired') await retire(key, version, language);
}
async function retire(key: string, version: number, language: string): Promise<void> {
  await t.k.sa.query(
    `UPDATE organisation.consent_template SET status = 'retired' WHERE key = $1 AND version = $2 AND language = $3`,
    [key, version, language],
  );
  publishedTemplates.delete(tpl(key, version, language));
}
const setLanguage = (patientId: string, language: string) =>
  q(`UPDATE patient.patient SET preferred_language = $2 WHERE id = $1`, [patientId, language]);

async function visit(n: number, serviceId: string, status = 'confirmed', start = APPT) {
  const p = await t.patient(n);
  const doc = (await t.doctor()).principalId;
  const rid = await t.seed(p, doc, start, { status, serviceId });
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
  title?: string | null;
  text?: string | null;
  status: string;
};
const itemsOf = (body: Record<string, unknown>): Item[] => body['requiredConsents'] as Item[];
const byKey = (items: Item[]) => Object.fromEntries(items.map((i) => [i.templateKey, i]));
const getItems = async (p: PatientKit, rid: string): Promise<Item[]> => {
  const r = await get(p, rid);
  assert.equal(r.status, 200, r.body);
  return itemsOf(r.json() as Record<string, unknown>);
};
const sign = (p: PatientKit, consentId: string) =>
  t.as(p.scope, (tx) =>
    t.k.patient.records.signConsent(tx, meta(), consentId, { typedName: 'Pat Ient' }),
  );
const request = (p: PatientKit, key: string, version: number, language: string) =>
  t.as(p.scope, (tx) =>
    t.k.patient.records.requestConsent(tx, meta(), p.patientId, key, version, language),
  );
const gateFor = () =>
  new ConsentGateService({
    audit: {} as never,
    catalog: { requiredConsents: (tx, sid) => t.org.consentTemplatesRequired(tx, sid) },
    consents: {
      status: (tx, pid, tpls) => t.k.patient.records.requiredConsentStatus(tx, pid, tpls),
    },
  });
const gateMissing = (p: PatientKit, serviceId: string) =>
  t.as(p.scope, (tx) => gateFor().missing(tx, p.patientId, serviceId));

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
const rejectsCode = async (p: Promise<unknown>, code: string, what: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, what);

describe('GET /appointments/{id}/previsit: requiredConsents (HEAAA-296 D1)', () => {
  test('two required templates: missing, pending (with id), signed and outdated; consents is all-signed; canOpenConsents follows the occupancy; the read writes nothing', async () => {
    t.clock.at = NOW;
    await template('a1-privacy', 1, 'en');
    await template('a1-treatment', 1, 'en');
    const svc = await service(['a1-privacy', 'a1-treatment']);
    const { p, rid } = await visit(601, svc);

    const r0 = await get(p, rid);
    assert.equal(r0.status, 200, r0.body);
    assert.equal(r0.headers['cache-control'], 'no-store');
    const b0 = r0.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(b0).sort(), [
      'canOpenConsents',
      'consents',
      'insurance',
      'questionnaire',
      'requiredConsents',
      'reservationId',
    ]);
    assert.equal(b0['canOpenConsents'], true);
    assert.deepEqual(
      itemsOf(b0).map((i) => [i.templateKey, i.status, i.id, i.templateVersion, i.language]),
      [
        ['a1-privacy', 'missing', null, 1, 'en'],
        ['a1-treatment', 'missing', null, 1, 'en'],
      ],
      'sorted by key, one item per template, en when the patient has no other preference',
    );
    assert.equal(itemsOf(b0)[0]?.title, '[PLACEHOLDER title a1-privacy v1 en]');
    assert.equal(
      itemsOf(b0)[0]?.text,
      '[PLACEHOLDER consent wording a1-privacy v1 en, not client text]',
    );
    assert.equal(b0['consents'], false);

    const pending = await request(p, 'a1-privacy', 1, 'en');
    const tr = await request(p, 'a1-treatment', 1, 'en');
    await sign(p, tr.id);
    const b1 = await getItems(p, rid);
    assert.deepEqual(
      b1.map((i) => [i.templateKey, i.status, i.id]),
      [
        ['a1-privacy', 'pending', pending.id],
        ['a1-treatment', 'signed', null],
      ],
    );

    await template('a1-treatment', 2, 'en');
    const k2 = byKey(await getItems(p, rid));
    assert.equal(k2['a1-treatment']?.status, 'outdated');
    assert.equal(k2['a1-treatment']?.templateVersion, 2);
    assert.equal(k2['a1-treatment']?.id, null, 'id only for a pending row');
    const b2 = (await get(p, rid)).json() as Record<string, unknown>;
    assert.equal(b2['consents'], false);

    await sign(p, pending.id);
    const tr2 = await request(p, 'a1-treatment', 2, 'en');
    await sign(p, tr2.id);
    const b3 = (await get(p, rid)).json() as Record<string, unknown>;
    assert.deepEqual(
      itemsOf(b3).map((i) => i.status),
      ['signed', 'signed'],
    );
    assert.equal(b3['consents'], true);

    // canOpenConsents: true for confirmed and checked_in, false otherwise; the statuses are still computed
    for (const [n, status, open] of [
      [602, 'confirmed', true],
      [603, 'checked_in', true],
      [604, 'completed', false],
      [605, 'cancelled_patient', false],
    ] as const) {
      const v = await visit(n, svc, status);
      const r = await get(v.p, v.rid);
      assert.equal(r.status, 200, `${status}: ${r.body}`);
      const b = r.json() as Record<string, unknown>;
      assert.equal(b['canOpenConsents'], open, status);
      assert.deepEqual(
        itemsOf(b).map((i) => i.status),
        ['missing', 'missing'],
      );
    }

    // a read writes nothing: patient.consent, kernel.idempotency_key and the audit table keep their counts
    const w = await visit(606, svc);
    const counts = async () => ({
      c: await consentRows(w.p.patientId),
      a: await auditRows(),
      k: await count(`SELECT count(*) AS n FROM kernel.idempotency_key`),
    });
    const c1 = await counts();
    await get(w.p, w.rid);
    await get(w.p, w.rid);
    assert.deepEqual(await counts(), c1);
    assert.equal(c1.c, 0);
  });

  test('language: the rule order (preferred, en, lowest); a service with no required consent gets []', async () => {
    t.clock.at = NOW;
    await template('a2-fr', 1, 'en');
    await template('a2-fr', 1, 'fr');
    await template('a2-only-de-fr', 1, 'de');
    await template('a2-only-de-fr', 1, 'fr');
    const svc = await service(['a2-fr', 'a2-only-de-fr']);
    const { p, rid } = await visit(610, svc);
    await setLanguage(p.patientId, 'fr');
    const k = byKey(await getItems(p, rid));
    assert.equal(k['a2-fr']?.language, 'fr');
    assert.equal(k['a2-fr']?.title, '[PLACEHOLDER title a2-fr v1 fr]');
    await setLanguage(p.patientId, 'it');
    const k2 = byKey(await getItems(p, rid));
    assert.equal(k2['a2-fr']?.language, 'en', 'preferred is not published: en');
    assert.equal(k2['a2-only-de-fr']?.language, 'de', 'no preferred and no en: the lowest value');
    const none = await visit(611, await service([]));
    const b = (await get(none.p, none.rid)).json() as Record<string, unknown>;
    assert.deepEqual(b['requiredConsents'], []);
    assert.equal(b['consents'], true);
  });

  test('2a: the version is the max across languages; the wording is always at that version (es v2 only, en v3)', async () => {
    t.clock.at = NOW;
    await template('a2a', 2, 'es');
    await template('a2a', 3, 'en');
    const svc = await service(['a2a']);
    const { p, rid } = await visit(620, svc);
    await setLanguage(p.patientId, 'es');
    const [item] = await getItems(p, rid);
    assert.equal(item?.templateVersion, 3);
    assert.equal(item?.language, 'en');
    assert.equal(item?.text, '[PLACEHOLDER consent wording a2a v3 en, not client text]');
    const r = await post(p, rid);
    assert.equal(r.status, 200, r.body);
    const rows = await q<{ template_version: number; template_language: string }>(
      `SELECT template_version, template_language FROM patient.consent WHERE patient_id = $1`,
      [p.patientId],
    );
    assert.deepEqual(rows, [{ template_version: 3, template_language: 'en' }]);
    assert.deepEqual(await gateMissing(p, svc), ['a2a']);
    const id = itemsOf(r.json() as Record<string, unknown>)[0]?.id as string;
    await sign(p, id);
    assert.deepEqual(await gateMissing(p, svc), [], 'signing it clears the consultation gate');
  });

  test('2b: published only; a draft newer version, a draft or retired key is never returned; the patient audience cannot read them', async () => {
    t.clock.at = NOW;
    await template('a2b-k', 1, 'en');
    await template('a2b-k', 2, 'en', 'draft');
    await template('a2b-r', 1, 'en', 'retired');
    const svc = await service(['a2b-k', 'a2b-r']);
    const { p, rid } = await visit(630, svc);
    const items = await getItems(p, rid);
    assert.deepEqual(
      items.map((i) => [i.templateKey, i.templateVersion, i.title]),
      [['a2b-k', 1, '[PLACEHOLDER title a2b-k v1 en]']],
    );
    const statusesOf = (scope: PatientKit['scope']) =>
      t.as(scope, async (tx) =>
        (
          await tx.query(
            `SELECT status FROM organisation.consent_template WHERE key IN ('a2b-k', 'a2b-r') ORDER BY status`,
          )
        ).rows.map((x) => x['status']),
      );
    assert.deepEqual(
      await statusesOf(p.scope),
      ['published'],
      'a patient-audience SELECT sees no draft or retired row',
    );
    assert.deepEqual(await statusesOf(await t.staffScope()), ['draft', 'published', 'retired']);
  });

  test('2c: a pending row keeps its language; the signed row records it; a retired language is withdrawn and reopened; the language is immutable in two layers', async () => {
    t.clock.at = NOW;
    await template('a2c', 1, 'en');
    await template('a2c', 1, 'fr');
    const svc = await service(['a2c']);
    const { p, rid } = await visit(640, svc);
    await setLanguage(p.patientId, 'fr');
    const opened = await post(p, rid);
    const [ref] = itemsOf(opened.json() as Record<string, unknown>);
    assert.equal(ref?.language, 'fr');
    await setLanguage(p.patientId, 'en');
    const [shown] = await getItems(p, rid);
    assert.equal(shown?.language, 'fr', 'the pending row decides the language shown');
    assert.equal(shown?.title, '[PLACEHOLDER title a2c v1 fr]');
    assert.equal(shown?.id, ref?.id);
    await sign(p, shown?.id as string);
    const signed = await q<{ template_language: string }>(
      `SELECT template_language FROM patient.consent WHERE id = $1`,
      [shown?.id],
    );
    assert.equal(signed[0]?.template_language, shown?.language);
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM audit.event WHERE resource_id = $1 AND action = 'update' AND change->>'templateLanguage' = 'fr' AND change->>'status' = 'signed'`,
        [shown?.id],
      ),
      1,
    );

    // immutability, two layers: app_api has no UPDATE grant on the column (42501); the trigger stops the owner role (PS001)
    await rejectsCode(
      t.as(p.scope, (tx) =>
        tx.query(`UPDATE patient.consent SET template_language = 'en' WHERE id = $1`, [shown?.id]),
      ),
      '42501',
      'app_api: no column grant',
    );
    for (const col of ["template_language = 'en'", 'template_version = 9', "template_key = 'z'"])
      await rejectsCode(
        saWrite(t.k, `UPDATE patient.consent SET ${col} WHERE id = $1`, [shown?.id]),
        'PS001',
        `owner: guard_consent pins ${col}`,
      );

    // SEC03-F11 (migration 2503): app_worker holds no UPDATE on patient.consent any more (the merge re-point runs in
    // patient.merge_repoint_consent, covered by worker-grants.dbtest)
    const other = await t.bare(641);
    await rejectsCode(
      t.asWorker(
        {
          audience: 'system',
          realm: 'worker',
          orgId: ORG,
          jobScope: 'patients',
          jobPatientIds: [p.patientId, other.patientId],
        },
        (tx) =>
          tx.query(`UPDATE patient.consent SET patient_id = $2 WHERE id = $1`, [
            shown?.id,
            other.patientId,
          ]),
      ),
      '42501',
      'app_worker: no UPDATE grant after 2503',
    );
    assert.equal(await consentRows(other.patientId), 0);

    // retiring the language of a pending row: the item is missing, the POST withdraws it (one audit row) and opens a new one
    await template('a2c-b', 1, 'en');
    await template('a2c-b', 1, 'fr');
    const svc2 = await service(['a2c-b']);
    const v = await visit(642, svc2);
    await setLanguage(v.p.patientId, 'fr');
    const first = itemsOf((await post(v.p, v.rid)).json() as Record<string, unknown>)[0] as Item;
    assert.equal(first.language, 'fr');
    await retire('a2c-b', 1, 'fr');
    const afterRetire = await getItems(v.p, v.rid);
    assert.deepEqual(
      afterRetire.map((i) => [i.status, i.id, i.language]),
      [['missing', null, 'en']],
    );
    const w0 = await auditFor(v.p.patientId, 'update');
    const c0 = await auditFor(v.p.patientId, 'create');
    const again = await post(v.p, v.rid);
    assert.equal(again.status, 200, again.body);
    assert.equal(await auditFor(v.p.patientId, 'update'), w0 + 1, 'one withdraw audit row');
    assert.equal(await auditFor(v.p.patientId, 'create'), c0 + 1, 'one create audit row');
    const stale = await q<{ status: string; reason: string; withdrawn_at: unknown }>(
      `SELECT status, reason, withdrawn_at FROM patient.consent WHERE id = $1`,
      [first.id],
    );
    assert.equal(stale[0]?.status, 'withdrawn');
    assert.equal(stale[0]?.reason, 'template_not_published');
    assert.ok(stale[0]?.withdrawn_at !== null);
    const sign409 = await call(t.k.base, 'POST', `/api/v1/consents/${first.id}/sign`, {
      host: HOST,
      cookie: v.p.session.cookie,
      headers: writeHeaders(v.p.session, HOST, randomUUID()),
      body: { typedName: 'Pat Ient' },
    });
    assert.equal(sign409.status, 409, sign409.body);
    assert.equal((sign409.json() as { code: string }).code, 'patient.consent_not_pending');
  });

  test('2d: a retired newer version does not block the patient; stale pending rows are withdrawn and the required version is opened', async () => {
    t.clock.at = NOW;
    await template('a2d', 3, 'en');
    await template('a2d', 4, 'en');
    const svc = await service(['a2d']);
    const { p, rid } = await visit(650, svc);
    const opened = itemsOf((await post(p, rid)).json() as Record<string, unknown>);
    assert.equal(opened[0]?.templateVersion, 4);
    const v4 = opened[0]?.id as string;
    await retire('a2d', 4, 'en');

    const [mid] = await getItems(p, rid);
    assert.deepEqual(
      [mid?.templateVersion, mid?.status, mid?.id],
      [3, 'missing', null],
      'every pending row is stale: missing, no id',
    );
    const b = (await get(p, rid)).json() as Record<string, unknown>;
    assert.equal(b['consents'], false);

    const upd0 = await auditFor(p.patientId, 'update');
    const cre0 = await auditFor(p.patientId, 'create');
    const r2 = await post(p, rid);
    assert.equal(r2.status, 200, r2.body);
    const [after] = itemsOf(r2.json() as Record<string, unknown>);
    assert.equal(after?.status, 'pending');
    assert.equal(after?.templateVersion, 3);
    assert.ok(typeof after?.id === 'string' && after.id !== v4);
    assert.equal(await auditFor(p.patientId, 'update'), upd0 + 1, 'exactly one withdraw audit row');
    assert.equal(await auditFor(p.patientId, 'create'), cre0 + 1, 'exactly one create audit row');
    const w = await q<{ status: string; reason: string; withdrawn_at: unknown }>(
      `SELECT status, reason, withdrawn_at FROM patient.consent WHERE id = $1`,
      [v4],
    );
    assert.equal(w[0]?.status, 'withdrawn');
    assert.equal(w[0]?.reason, 'template_not_published');
    assert.ok(w[0]?.withdrawn_at !== null, 'withdrawn_at is set by the guard');

    await sign(p, after?.id as string);
    assert.equal((await getItems(p, rid))[0]?.status, 'signed');
    assert.deepEqual(await gateMissing(p, svc), []);
  });

  test('2d variant: a current pending v3 row and a stale pending v4 row: pending with the v3 id; the POST withdraws only v4 and opens nothing', async () => {
    t.clock.at = NOW;
    await template('a2e', 3, 'en');
    const svc = await service(['a2e']);
    const { p, rid } = await visit(651, svc);
    const v3 = itemsOf((await post(p, rid)).json() as Record<string, unknown>)[0] as Item;
    await template('a2e', 4, 'en');
    const v4 = await request(p, 'a2e', 4, 'en');
    await retire('a2e', 4, 'en');
    const [item] = await getItems(p, rid);
    assert.deepEqual([item?.status, item?.id, item?.templateVersion], ['pending', v3.id, 3]);
    const cre0 = await auditFor(p.patientId, 'create');
    const upd0 = await auditFor(p.patientId, 'update');
    const rows0 = await consentRows(p.patientId);
    const r = await post(p, rid);
    assert.equal(r.status, 200, r.body);
    assert.equal(itemsOf(r.json() as Record<string, unknown>)[0]?.id, v3.id);
    assert.equal(await consentRows(p.patientId), rows0, 'nothing opened');
    assert.equal(await auditFor(p.patientId, 'create'), cre0);
    assert.equal(await auditFor(p.patientId, 'update'), upd0 + 1);
    const st = await q<{ id: string; status: string }>(
      `SELECT id, status FROM patient.consent WHERE id IN ($1, $2) ORDER BY template_version`,
      [v3.id, v4.id],
    );
    assert.deepEqual(
      st.map((x) => x.status),
      ['pending', 'withdrawn'],
    );
  });
});

describe('POST /appointments/{id}/previsit/consents (HEAAA-296 D2)', () => {
  test('3: opens pending rows only for missing/outdated; compact body; replay; a new key adds nothing; concurrent calls create one row per template version', async () => {
    t.clock.at = NOW;
    await template('b3-privacy', 1, 'en');
    await template('b3-treatment', 1, 'en');
    const svc = await service(['b3-privacy', 'b3-treatment']);
    const { p, rid } = await visit(660, svc);
    const key = randomUUID();
    const auditBefore = await auditRows();
    const r1 = await post(p, rid, key);
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r1.headers['cache-control'], 'no-store');
    const b1 = r1.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(b1).sort(), ['requiredConsents', 'reservationId']);
    const items = itemsOf(b1);
    assert.deepEqual(
      items.map((i) => [i.templateKey, i.status]),
      [
        ['b3-privacy', 'pending'],
        ['b3-treatment', 'pending'],
      ],
    );
    for (const i of items) {
      assert.deepEqual(Object.keys(i).sort(), [
        'id',
        'language',
        'status',
        'templateKey',
        'templateVersion',
      ]);
      assert.equal(typeof i.id, 'string');
    }
    assert.equal(await consentRows(p.patientId), 2);
    assert.equal(await auditFor(p.patientId, 'create'), 2);
    assert.equal(await auditRows(), auditBefore + 2);

    const replay = await post(p, rid, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['idempotent-replay'], 'true');
    assert.deepEqual(replay.json(), b1);

    const again = await post(p, rid, randomUUID());
    assert.deepEqual(
      itemsOf(again.json() as Record<string, unknown>).map((i) => i.id),
      items.map((i) => i.id),
      'the same pending rows',
    );
    assert.equal(await consentRows(p.patientId), 2);
    assert.equal(await auditFor(p.patientId, 'create'), 2);

    // a signed item is left alone; a newer version of it opens a new row, the other open row is untouched
    await sign(p, items[0]?.id as string);
    await template('b3-privacy', 2, 'en');
    const k3 = byKey(itemsOf((await post(p, rid)).json() as Record<string, unknown>));
    assert.equal(k3['b3-privacy']?.status, 'pending');
    assert.equal(k3['b3-privacy']?.templateVersion, 2);
    assert.equal(k3['b3-treatment']?.id, items[1]?.id, 'the open treatment row is untouched');
    assert.equal(await consentRows(p.patientId), 3);

    // concurrency: exactly one pending row per template version
    const c = await visit(661, svc);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.as(c.p.scope, (tx) => t.flow.openPrevisitConsents(tx, meta(), c.rid)),
      ),
    );
    assert.equal(await consentRows(c.p.patientId), 2);
    assert.equal(new Set(results.flatMap((r) => r.requiredConsents.map((i) => i.id))).size, 2);
    const http = await Promise.all(Array.from({ length: 4 }, () => post(c.p, c.rid)));
    assert.ok(http.every((r) => r.status === 200));
    assert.equal(await consentRows(c.p.patientId), 2);
  });

  test('3b: the key is bound to the principal and the reservation', async () => {
    t.clock.at = NOW;
    await template('b3b', 1, 'en');
    const svc = await service(['b3b']);
    const a = await visit(670, svc);
    const b = await visit(671, svc);
    const key = randomUUID();
    const first = await post(a.p, a.rid, key);
    assert.equal(first.status, 200, first.body);
    const second = await post(b.p, b.rid, key);
    assert.equal(second.status, 200, second.body);
    assert.equal(second.headers['idempotent-replay'], undefined, 'a fresh request, not a replay');
    assert.notDeepEqual(second.json(), first.json(), "never the first caller's body");
    assert.equal(await consentRows(b.p.patientId), 1);
    // the same principal, another reservation, the same key
    const doc = (await t.doctor()).principalId;
    const rid2 = await t.seed(a.p, doc, APPT2, { status: 'confirmed', serviceId: svc });
    const clash = await post(a.p, rid2, key);
    assert.equal(clash.status, 409, clash.body);
    assert.equal((clash.json() as { code: string }).code, 'kernel.idempotency_conflict');
  });

  test('3c: the 11th call in 10 minutes is 429; repeated calls add no consent and no audit rows', async () => {
    t.clock.at = NOW;
    await template('b3c', 1, 'en');
    const svc = await service(['b3c']);
    const { p, rid } = await visit(680, svc);
    assert.equal((await post(p, rid)).status, 200);
    const rows = await consentRows(p.patientId);
    const audit = await auditRows();
    for (let i = 2; i <= 10; i++) assert.equal((await post(p, rid)).status, 200, `call ${i}`);
    assert.equal(await consentRows(p.patientId), rows);
    assert.equal(await auditRows(), audit, 'no new audit rows once all items are pending');
    const over = await post(p, rid);
    assert.equal(over.status, 429, over.body);
    assert.equal((over.json() as { code: string }).code, 'kernel.rate_limited');
    assert.ok(Number(over.headers['retry-after']) > 0, 'Retry-After');
    assert.equal(await consentRows(p.patientId), rows);
    // another reservation of the same principal has its own counter
    const doc = (await t.doctor()).principalId;
    const rid2 = await t.seed(p, doc, APPT2, { status: 'confirmed', serviceId: svc });
    assert.equal((await post(p, rid2)).status, 200);
  });

  test('4: a proxy gets 404 on both routes and nothing is written; another patient, a missing and a cancelled reservation get 404; checked in is allowed; unauthenticated is 401', async () => {
    t.clock.at = NOW;
    await template('b4', 1, 'en');
    const svc = await service(['b4']);
    const { p, rid } = await visit(690, svc);
    const proxy = await proxyOf(p.patientId, 'Proxy 690');
    const g = await get(proxy, rid);
    assert.equal(g.status, 404, g.body);
    assert.equal((g.json() as { code: string }).code, 'kernel.not_found');
    const po = await post(proxy, rid);
    assert.equal(po.status, 404, po.body);
    assert.equal((po.json() as { code: string }).code, 'kernel.not_found');
    assert.equal(await consentRows(p.patientId), 0);
    assert.equal(
      await count(`SELECT count(*) AS n FROM kernel.idempotency_key WHERE principal_id = $1`, [
        proxy.scope.principalId,
      ]),
      0,
      'the handler was not entered',
    );

    const stranger = await t.bare(691);
    assert.equal((await get(stranger, rid)).status, 404);
    assert.equal((await post(stranger, rid)).status, 404);
    assert.equal((await post(p, randomUUID())).status, 404, 'a reservation that does not exist');
    assert.equal((await get({ session: { cookie: 'x' } }, rid)).status, 401);

    const cancelled = await visit(692, svc, 'cancelled_patient');
    assert.equal((await post(cancelled.p, cancelled.rid)).status, 404);
    assert.equal(await consentRows(cancelled.p.patientId), 0);
    const view = await get(cancelled.p, cancelled.rid);
    assert.equal(view.status, 200);
    assert.equal((view.json() as Record<string, unknown>)['canOpenConsents'], false);

    const here = await visit(693, svc, 'checked_in');
    assert.equal((await post(here.p, here.rid)).status, 200);
    assert.equal(await consentRows(here.p.patientId), 1);
  });

  test('4b: RLS refuses the patient inserts it must refuse, at the database, under app_api; a staff session never reaches the handler', async () => {
    t.clock.at = NOW;
    await template('b4b', 1, 'en');
    const svc = await service(['b4b']);
    const { p, rid } = await visit(700, svc);
    const other = await t.bare(701);
    const insert = (scope: PatientKit['scope'], patientId: string, status = 'pending') =>
      t.as(scope, (tx) =>
        tx.query(
          `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, created_by)
           VALUES ($1, kernel.uuid1('app.org_id'), $2, 'b4b', 1, 'en', $3, kernel.uuid1('app.principal_id'))`,
          [randomUUID(), patientId, status],
        ),
      );
    // (i) a patient outside app.patient_ids
    await rejectsCode(insert(p.scope, other.patientId), '42501', 'another patient');
    // (ii) the patient is in app.proxy_patient_ids
    const proxy = await proxyOf(p.patientId, 'Proxy 700');
    await rejectsCode(insert(proxy.scope, p.patientId), '42501', 'proxy insert');
    // (iii) status = signed
    await rejectsCode(insert(p.scope, p.patientId, 'signed'), '42501', 'signed insert');
    assert.equal(await consentRows(p.patientId), 0);
    assert.equal(await consentRows(other.patientId), 0);
    // sanity: the same insert for the patient's own id and a pending status is allowed
    await insert(p.scope, p.patientId);
    assert.equal(await consentRows(p.patientId), 1);
    // (iv) a staff (google realm) session on both routes
    const g = await get({ session: t.deskA1 }, rid);
    const po = await post({ ...p, session: t.deskA1 }, rid);
    assert.deepEqual(
      [g.status, po.status],
      [403, 403],
      'the realm guard answers before the handler',
    );
    assert.equal(await consentRows(p.patientId), 1);
  });

  test('4c: the column grants are enough under app_api: request, stale withdraw and sign succeed; withdrawn_at is not grantable', async () => {
    t.clock.at = NOW;
    await template('b4c', 1, 'en');
    await template('b4c', 1, 'fr');
    const svc = await service(['b4c']);
    const { p } = await visit(710, svc);
    const a = await request(p, 'b4c', 1, 'fr');
    assert.equal(a.templateLanguage, 'fr');
    const ok = await t.as(p.scope, (tx) =>
      t.k.patient.records.withdrawStalePendingConsent(tx, meta(), a.id),
    );
    assert.equal(ok, true);
    const row = await q<{ status: string; reason: string; withdrawn_at: unknown }>(
      `SELECT status, reason, withdrawn_at FROM patient.consent WHERE id = $1`,
      [a.id],
    );
    assert.deepEqual(
      [row[0]?.status, row[0]?.reason, row[0]?.withdrawn_at !== null],
      ['withdrawn', 'template_not_published', true],
    );
    assert.equal(
      await t.as(p.scope, (tx) =>
        t.k.patient.records.withdrawStalePendingConsent(tx, meta(), a.id),
      ),
      false,
      'a withdrawn row is not pending: nothing more to withdraw',
    );
    const b = await request(p, 'b4c', 1, 'en');
    const s = await sign(p, b.id);
    assert.equal(s.status, 'signed');
    const open = await request(p, 'b4c', 1, 'fr');
    await rejectsCode(
      t.as(p.scope, (tx) =>
        tx.query(`UPDATE patient.consent SET withdrawn_at = now() WHERE id = $1`, [open.id]),
      ),
      '42501',
      'no UPDATE grant on withdrawn_at',
    );
    await rejectsCode(
      t.as(p.scope, (tx) =>
        t.k.patient.records.requestConsent(tx, meta(), p.patientId, 'b4c', 1, 'xx'),
      ),
      'kernel.validation_failed',
      'a language that is not published',
    );
  });

  test('5: the returned id signs through the route; the GET then shows signed and the consultation gate no longer lists the key', async () => {
    t.clock.at = NOW;
    await template('b5-a', 1, 'en');
    await template('b5-b', 1, 'en');
    const svc = await service(['b5-a', 'b5-b']);
    const { p, rid } = await visit(720, svc);
    assert.deepEqual(await gateMissing(p, svc), ['b5-a', 'b5-b']);
    const items = itemsOf((await post(p, rid)).json() as Record<string, unknown>);
    assert.deepEqual(await gateMissing(p, svc), ['b5-a', 'b5-b'], 'pending is not signed');
    const s = await call(t.k.base, 'POST', `/api/v1/consents/${items[0]?.id}/sign`, {
      host: HOST,
      cookie: p.session.cookie,
      headers: writeHeaders(p.session, HOST, randomUUID()),
      body: { typedName: 'Pat Ient' },
    });
    assert.equal(s.status, 200, s.body);
    const after = byKey(await getItems(p, rid));
    assert.equal(after['b5-a']?.status, 'signed');
    assert.equal(after['b5-a']?.id, null);
    assert.deepEqual(await gateMissing(p, svc), ['b5-b']);
  });

  test('validation: the idempotency key is required, a body with a field is refused, an empty object is accepted; a bad id is 404', async () => {
    t.clock.at = NOW;
    await template('b6', 1, 'en');
    const svc = await service(['b6']);
    const { p, rid } = await visit(730, svc);
    const noKey = await call(t.k.base, 'POST', `/api/v1/appointments/${rid}/previsit/consents`, {
      host: HOST,
      cookie: p.session.cookie,
      headers: writeHeaders(p.session, HOST),
    });
    assert.equal(noKey.status, 400);
    assert.equal((noKey.json() as { code: string }).code, 'kernel.idempotency_key_required');
    const extra = await post(p, rid, randomUUID(), { templateKey: 'b6' });
    assert.ok([400, 422].includes(extra.status), `status ${extra.status}`);
    assert.equal((extra.json() as { code: string }).code, 'kernel.validation_failed');
    assert.equal(await consentRows(p.patientId), 0);
    assert.equal((await post(p, rid, randomUUID(), {})).status, 200);
    assert.equal((await post(p, 'not-a-uuid')).status, 404);
  });
});

describe('migration and wording hygiene (HEAAA-296 D3, rules 5-8)', () => {
  test('6: the five new constraints are validated; a published template without text, a consent without a language and an edit of a published row fail', async () => {
    const cons = await q<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname IN
         ('consent_template_title_len', 'consent_template_body_text_len', 'consent_template_published_has_text',
          'consent_template_language_len', 'consent_template_language_present') ORDER BY conname`,
    );
    assert.equal(cons.length, 5);
    assert.ok(
      cons.every((c) => c.convalidated),
      'all validated',
    );
    await rejectsCode(
      saWrite(
        t.k,
        `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
         VALUES ($1, $2, 'c6a', 1, 'en', 'T', null, 'published')`,
        [randomUUID(), ORG],
      ),
      '23514',
      'published without body_text',
    );
    await rejectsCode(
      saWrite(
        t.k,
        `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
         VALUES ($1, $2, 'c6b', 1, 'en', null, 'x', 'published')`,
        [randomUUID(), ORG],
      ),
      '23514',
      'published without title',
    );
    const p = await t.bare(740);
    await rejectsCode(
      saWrite(
        t.k,
        `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version) VALUES ($1, $2, $3, 'c6', 1)`,
        [randomUUID(), ORG, p.patientId],
      ),
      '23514',
      'consent without template_language',
    );
    await template('c6-pub', 1, 'en');
    for (const set of ["body_text = 'edited'", "title = 'edited'"])
      await rejectsCode(
        saWrite(t.k, `UPDATE organisation.consent_template SET ${set} WHERE key = 'c6-pub'`),
        '42501',
        `guard_template_version: ${set}`,
      );
  });

  test('7: neither the wording nor a marker in it appears in the log output or an audit payload of the GET, the POST and the sign', async () => {
    t.clock.at = NOW;
    const marker = `MARKER-${randomUUID()}`;
    await t.k.sa.query(
      `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, status)
       VALUES ($1, $2, 'c7', 1, 'en', $3, $4, 'published')`,
      [randomUUID(), ORG, `[PLACEHOLDER] ${marker} title`, `[PLACEHOLDER] ${marker} wording`],
    );
    publishedTemplates.add(tpl('c7', 1, 'en'));
    const svc = await service(['c7']);
    const { p, rid } = await visit(750, svc);
    const captured: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const spy =
      (orig: typeof out) =>
      (chunk: unknown, ...rest: unknown[]): boolean => {
        captured.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString(),
        );
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
    process.stdout.write = spy(out) as typeof process.stdout.write;
    process.stderr.write = spy(err) as typeof process.stderr.write;
    let body: string | undefined;
    try {
      const g = await get(p, rid);
      body = g.body;
      const po = await post(p, rid);
      assert.ok(!po.body.includes(marker), 'the POST body carries no wording');
      await call(
        t.k.base,
        'POST',
        `/api/v1/consents/${itemsOf(po.json() as Record<string, unknown>)[0]?.id}/sign`,
        {
          host: HOST,
          cookie: p.session.cookie,
          headers: writeHeaders(p.session, HOST, randomUUID()),
          body: { typedName: 'Pat Ient' },
        },
      );
    } finally {
      process.stdout.write = out as typeof process.stdout.write;
      process.stderr.write = err as typeof process.stderr.write;
    }
    assert.ok(body?.includes(marker), 'the GET carries the wording');
    assert.ok(!captured.join('').includes(marker), 'log output');
    assert.equal(
      await count(`SELECT count(*) AS n FROM audit.event e WHERE to_jsonb(e)::text LIKE $1`, [
        `%${marker}%`,
      ]),
      0,
      'audit payloads',
    );
    assert.equal(
      await count(
        `SELECT count(*) AS n FROM kernel.idempotency_key WHERE convert_from(response_body, 'UTF8') LIKE $1`,
        [`%${marker}%`],
      ),
      0,
      'idempotency store',
    );
  });
});
