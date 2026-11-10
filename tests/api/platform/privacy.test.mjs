// TC-PR-01..05 (TEST-CASES 9.4). ENV-INT/ci. Compliance actions run in the admin realm (CMP-1 / CMP-2), elevated with a real
// WebAuthn assertion. The package store and its presigner are infrastructure that does not exist in ci (C-01): the download half
// of TC-PR-02 is BLOCKED; the assembly half is asserted and FAILS on the product (QA05-F02).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPatient, sql, until, closeAdmin } from './lib/world.mjs';
import { adminClient, elevate } from './lib/admin.mjs';

after(() => closeAdmin());
let cmp;
const compliance = async () => {
  if (!cmp) {
    cmp = await adminClient('CMP-1');
    const e = await elevate(cmp);
    assert.equal(e.status, 200, `elevation ${e.status}`);
  }
  return cmp;
};

describe('TC-PR', () => {
  test('TC-PR-01 notification preferences: SMS off, email on, saved and read back after reload', async () => {
    const p = await newPatient();
    const get = await p.client.get(`/api/v1/patients/${p.id}/communication-preferences`);
    assert.equal(get.status, 200);
    const put = await p.client.put(`/api/v1/patients/${p.id}/communication-preferences`, {
      channels: ['email'],
      reminderChannel: 'email',
      language: 'en',
    });
    assert.equal(put.status, 200, `save ${put.status} ${put.text.slice(0, 200)}`);
    const again = await p.client.get(`/api/v1/patients/${p.id}/communication-preferences`);
    assert.ok(
      again.json.channels.includes('email') && !again.json.channels.includes('sms'),
      `SMS off, email on after reload (channels ${JSON.stringify(again.json.channels)})`,
    );
    const marketing = await p.client.put(
      `/api/v1/patients/${p.id}/communication-preferences`,
      { channels: ['email'], language: 'en', marketingOptIn: true },
      { headers: { 'if-match': again.headers.etag } },
    );
    assert.equal(marketing.status, 422, 'marketing opt-in cannot be switched on (R1)');
    // "respected" half (an SMS is not sent) is TC-NT-08 (QA-04).
  });

  test('TC-PR-02 export request: identity check, compliance sees it, assembled in chunks (each audited), delivered via the portal', async () => {
    const c = await compliance();
    const p = await newPatient();
    const r = await p.client.post('/api/v1/privacy-requests', {
      kind: 'export',
      detail: 'QA-05 export check',
    });
    assert.equal(r.status, 201, `create ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.json.status, 'received');
    const seen = await c.get(`/api/v1/admin/privacy-requests?status=received`);
    assert.equal(seen.status, 200);
    assert.ok(
      seen.json.items.some((x) => x.id === r.json.id),
      'compliance sees the request',
    );
    const v = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/verify-identity`, {
      method: 'photo id in person',
    });
    assert.equal(v.status, 200);
    assert.equal(v.json.status, 'identity_verified');
    const d = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'approve',
    });
    assert.equal(d.status, 200);
    const final = null;
    const pkg = await until(
      async () => {
        const q = await sql(
          `SELECT status, failure_code FROM privacy.export_package WHERE request_id = $1`,
          [r.json.id],
        );
        return q.rows[0] && q.rows[0].status !== 'assembling' ? q : null;
      },
      { timeoutMs: 15000, everyMs: 500 },
    );
    assert.equal(
      pkg?.rows[0]?.status,
      'ready',
      `QA05-F02: the export package ended '${pkg?.rows[0]?.status}' (${pkg?.rows[0]?.failure_code}); the request the patient sees stays '${(await p.client.get(`/api/v1/privacy-requests/${r.json.id}`)).json?.status}'`,
    );
    void final;
  });

  test(
    'TC-PR-02b the finished export is downloaded through the portal with a short-lived link and no PHI in the e-mail',
    {
      skip: 'BLOCKED: no package store or presigner in ENV-INT/ci (C-01); the API composition has the refusing presigner. Needs ENV-INT/staging',
    },
    () => {},
  );

  test('TC-PR-03 deletion request is recorded and visible to compliance; nothing is deleted (D-8 open)', async () => {
    const c = await compliance();
    const p = await newPatient();
    const r = await p.client.post('/api/v1/privacy-requests', { kind: 'deletion' });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'blocked_d8', 'recorded and blocked on D-8');
    const list = await c.get(`/api/v1/admin/privacy-requests?status=blocked_d8`);
    assert.ok(
      list.json.items.some((x) => x.id === r.json.id),
      'compliance sees it',
    );
    const approve = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'approve',
    });
    assert.ok(
      approve.status >= 400,
      `a deletion cannot be approved while D-8 is open (${approve.status})`,
    );
    const still = await sql(`SELECT status FROM patient.patient WHERE id=$1`, [p.id]);
    assert.equal(still.rows[0].status, 'active', 'no patient data was deleted');
    // what deletion MEANS is BLOCKED on D-8.
  });

  test("TC-PR-04 another patient's request and export cannot be read or downloaded", async () => {
    const a = await newPatient();
    const b = await newPatient();
    const r = await a.client.post('/api/v1/privacy-requests', { kind: 'export' });
    assert.equal(r.status, 201);
    const get = await b.client.get(`/api/v1/privacy-requests/${r.json.id}`);
    assert.equal(get.status, 404);
    const dl = await b.client.post(`/api/v1/privacy-requests/${r.json.id}/export/download-url`, {});
    assert.equal(dl.status, 404);
    const own = await b.client.get('/api/v1/privacy-requests');
    assert.ok(!own.json.items.some((x) => x.id === r.json.id), "not in the other patient's list");
  });

  test('TC-PR-05 processing before the identity check is refused; a refusal needs a reason and is recorded', async () => {
    const c = await compliance();
    const p = await newPatient();
    const r = await p.client.post('/api/v1/privacy-requests', { kind: 'export' });
    const early = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'approve',
    });
    assert.equal(early.status, 409);
    assert.equal(early.json?.code, 'privacy.invalid_transition');
    const noReason = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'refuse',
    });
    assert.ok(
      [400, 422].includes(noReason.status),
      `refusal without a reason is refused (${noReason.status})`,
    );
    const refuse = await c.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'refuse',
      reason: 'Identity could not be verified (QA-05 synthetic).',
    });
    assert.equal(refuse.status, 200, `refuse ${refuse.status} ${refuse.text.slice(0, 200)}`);
    assert.equal(refuse.json.status, 'refused');
    assert.match(refuse.json.decisionReason, /Identity could not be verified/);
  });
});
