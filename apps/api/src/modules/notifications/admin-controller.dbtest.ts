/* eslint-disable boundaries/module-boundaries -- test support: drives the admin routes through the real identity guard, sessions and elevation kit, the way the composition root mounts them */
// Real-database tests for the message-template admin routes (TC-AD-04, RA-R1-05, RA-R1-15, ARCHITECTURE 22.13): HTTP through the
// real guard (admin realm, permission, live elevation grant), TemplateService, FORCE-RLS tables and the audit store on PostgreSQL 17.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/notifications/admin-controller.dbtest.js
// Missing configuration FAILS; nothing skips. All data is synthetic.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { adminWith, api, orgAdminSetup, seedReference } from '../organisation/admin/testkit.js';
import type { Admin, OrgKit, Resp } from '../organisation/admin/testkit.js';
import { requireAuthContext } from '../identity/guard-policy.js';
import { createTemplateAdminController } from './admin-controller.js';
import { TemplateService } from './templates.js';

let k: OrgKit;
let adm: Admin;
let nonElevated: Admin;
before(async () => {
  k = await orgAdminSetup('tmpladmin', (kit, audit) => [
    createTemplateAdminController({
      db: kit.db,
      scopeOf: (req) => requireAuthContext(req).scope,
      templates: new TemplateService({
        audit,
        configuredLanguages: () => Promise.resolve(['en', 'es']),
      }),
    }),
  ]);
  await seedReference(k);
  adm = await adminWith(k, ['org_admin']);
  nonElevated = await adminWith(k, ['org_admin'], { elevated: false });
});
after(async () => {
  await k.close();
});

const PATH = '/message-templates';
const j = (r: Resp): Record<string, unknown> => r.json();
const rules = (r: Resp): string[] => (j(r)['errors'] as { code: string }[]).map((e) => e.code);

const row = (channel: string, language: string, over: Record<string, unknown> = {}) => ({
  key: 'tc_ad_04_note',
  channel,
  language,
  subject: channel === 'email' ? 'Update about your visit' : undefined,
  body: 'Sign in to your patient portal for details: {{portal_link}}',
  variables: [{ name: 'portal_link', type: 'url' }],
  ...over,
});

describe('TC-AD-04: message templates are restricted to the variable allowlist', () => {
  test('a template binding a non-allowlisted variable (diagnosis, clinician, free text) is refused with 422 and nothing is stored', async () => {
    for (const [name, body] of [
      ['diagnosis', 'Your {{diagnosis}} result is ready'],
      ['clinician_name', 'Dr {{clinician_name}} will see you'],
    ] as const) {
      const r = await api(k, adm, 'POST', PATH, {
        ...row('sms', 'en', { key: 'bad_binding', body, variables: [{ name, type: 'text' }] }),
      });
      assert.equal(r.status, 422, r.body);
      assert.equal(j(r)['code'], 'notifications.render_check_failed');
      assert.ok(rules(r).includes('variable_not_allowed'));
      assert.ok(
        !r.body.includes(name === 'diagnosis' ? 'result is ready' : 'will see you'),
        'no template text echoed',
      );
    }
    // allowlisted name declared with the wrong type
    const wrongType = await api(
      k,
      adm,
      'POST',
      PATH,
      row('sms', 'en', { key: 'bad_binding', variables: [{ name: 'portal_link', type: 'text' }] }),
    );
    assert.equal(wrongType.status, 422);
    // placeholder used but not declared
    const undeclared = await api(
      k,
      adm,
      'POST',
      PATH,
      row('sms', 'en', { key: 'bad_binding', variables: [] }),
    );
    assert.equal(undeclared.status, 422);
    assert.ok(rules(undeclared).includes('placeholder_not_declared'));
    const stored = await k.q(`SELECT 1 FROM notifications.template WHERE key = 'bad_binding'`);
    assert.equal(stored.length, 0);
  });

  test('a free-text binding field in the body is a 400; unknown fields are never stored', async () => {
    const r = await api(k, adm, 'POST', PATH, {
      ...row('sms', 'en', { key: 'free_text' }),
      bindings: { x: 'free text' },
    });
    assert.equal(r.status, 400, r.body);
    assert.equal(j(r)['code'], 'kernel.validation_failed');
    const r2 = await api(
      k,
      adm,
      'POST',
      PATH,
      row('sms', 'en', {
        key: 'free_text',
        variables: [{ name: 'portal_link', type: 'url', value: 'x' }],
      }),
    );
    assert.equal(r2.status, 400, r2.body);
    assert.equal(
      (await k.q(`SELECT 1 FROM notifications.template WHERE key = 'free_text'`)).length,
      0,
    );
  });

  test('draft per language, render check needs every configured language, publish, list, and every change is audited', async () => {
    const en = await api(k, adm, 'POST', PATH, row('email', 'en'));
    assert.equal(en.status, 200, en.body);
    assert.equal(j(en)['status'], 'draft');
    assert.equal(j(en)['version'], 1);
    assert.equal(en.headers['cache-control'], 'no-store');
    const id = String(j(en)['id']);

    // Spanish is configured but missing: the check and the publish are refused
    const missing = await api(k, adm, 'POST', `${PATH}/${id}/render-check`, {});
    assert.equal(missing.status, 422, missing.body);
    assert.ok(rules(missing).includes('language_missing'));
    const early = await api(k, adm, 'POST', `${PATH}/${id}/publish`);
    assert.equal(early.status, 422);
    assert.ok(rules(early).includes('render_check_not_run'));

    const es = await api(
      k,
      adm,
      'POST',
      PATH,
      row('email', 'es', {
        version: 1,
        subject: 'Novedades de su visita',
        body: 'Ingrese a su portal: {{portal_link}}',
      }),
    );
    assert.equal(es.status, 200, es.body);
    const ok = await api(k, adm, 'POST', `${PATH}/${id}/render-check`, {});
    assert.equal(ok.status, 200, ok.body);
    assert.equal(j(ok)['rows'], 2);
    const pub = await api(k, adm, 'POST', `${PATH}/${id}/publish`);
    assert.equal(pub.status, 200, pub.body);

    const list = await api(k, adm, 'GET', `${PATH}?key=tc_ad_04_note&status=published`);
    assert.equal(list.status, 200);
    const items = j(list)['items'] as Record<string, unknown>[];
    assert.deepEqual(items.map((x) => x['language']).sort(), ['en', 'es']);
    assert.equal(j(list)['nextCursor'], null);
    const paged = await api(k, adm, 'GET', `${PATH}?key=tc_ad_04_note&limit=1`);
    assert.notEqual(j(paged)['nextCursor'], null);

    // published content is frozen: a further POST to that version is refused
    const frozen = await api(k, adm, 'POST', PATH, row('sms', 'en', { version: 1 }));
    assert.equal(frozen.status, 400);

    const audit = await k.q(
      `SELECT action, actor_principal_id, realm, change FROM audit.event WHERE resource_type = 'notifications.template' ORDER BY occurred_at, event_id`,
    );
    assert.ok(audit.length === 4, 'draft x2, check, publish; refused calls leave no audit row');
    assert.ok(
      audit.every(
        (a) =>
          a['action'] === 'config_change' &&
          a['realm'] === 'admin_pool' &&
          a['actor_principal_id'] === adm.principalId,
      ),
    );
    assert.ok(audit.some((a) => (a['change'] as { status?: string }).status === 'published'));
  });

  test('guard: no session 401, non-elevated admin refused, write never happens', async () => {
    const anon = await api(k, undefined, 'GET', PATH);
    assert.equal(anon.status, 401);
    const noElev = await api(k, nonElevated, 'POST', PATH, row('sms', 'en', { key: 'no_elev' }));
    assert.equal(noElev.status, 403, noElev.body);
    const readNoElev = await api(k, nonElevated, 'GET', PATH);
    assert.equal(readNoElev.status, 403);
    assert.equal(
      (await k.q(`SELECT 1 FROM notifications.template WHERE key = 'no_elev'`)).length,
      0,
    );
  });
});
