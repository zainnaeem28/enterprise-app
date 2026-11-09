// TC-DOC-01..08 (TEST-CASES 9.3). ENV-INT/ci. The object store, malware scanner and OCR vendor are not provisioned (C-01, C-10):
// the API composition has the refusing presigner, so every case that needs a real upload, scan or pre-signed URL stays BLOCKED
// naming it. Cases that start from "a document is on file" use a document row the test writes through the product's own triggers
// (fixtureDocument), which does NOT exercise the upload path; the evidence says so.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPatient, newStaff, login, sql, fixtureDocument, closeAdmin, until, A1, setSetting, principalId } from './lib/world.mjs';

after(() => closeAdmin());
const STORE = 'BLOCKED: no object store, malware scanner or OCR vendor in ENV-INT/ci (C-01, C-10); the API composition has the refusing presigner. Needs ENV-INT/staging with the bucket and scanner';

describe('TC-DOC', () => {
  test('TC-DOC-01 upload of a clean PDF: unavailable until scanned clean, then classified and confirmed [store + scanner]', { skip: STORE }, () => {});
  test('TC-DOC-02 EICAR upload is quarantined, uploader told, clinicians cannot open it [real scanner]', { skip: STORE }, () => {});
  test('TC-DOC-05 pre-signed URLs go to the object store, expire, and cannot read another patient\'s file [store]', { skip: STORE }, () => {});
  test('TC-DOC-08 scanner outage: file stays unavailable, visible failure, no bypass [scanner]', { skip: STORE }, () => {});

  test('TC-DOC-00 observation: without a store an upload request is refused (never faked)', async () => {
    const p = await newPatient();
    const r = await p.client.post(`/api/v1/patients/${p.id}/document-uploads`, { contentType: 'application/pdf', sizeBytes: 1000 });
    assert.notEqual(r.status, 201, 'no upload URL is handed out without a store');
    assert.doesNotMatch(r.text, /https?:\/\/objects|X-Amz|signature=/i, 'nothing that looks like a URL leaks');
  });

  test('TC-DOC-03 disallowed type, double extension and oversize are rejected with a safe error', async () => {
    const p = await newPatient();
    const up = (b) => p.client.post(`/api/v1/patients/${p.id}/document-uploads`, b);
    const exe = await up({ contentType: 'application/x-msdownload', sizeBytes: 1000 });
    assert.ok([415, 422].includes(exe.status), `executable type refused (${exe.status})`);
    assert.match(exe.json?.code ?? '', /type_not_allowed|validation/);
    const dbl = await up({ contentType: 'application/pdf', sizeBytes: 1000, fileName: 'report.pdf.exe' });
    assert.ok([415, 422].includes(dbl.status), `double extension refused (${dbl.status})`);
    const mismatch = await up({ contentType: 'application/pdf', sizeBytes: 1000, fileName: 'scan.png' });
    assert.ok([415, 422].includes(mismatch.status), `extension that does not match the declared type refused (${mismatch.status})`);
    const big = await up({ contentType: 'application/pdf', sizeBytes: 5 * 1024 * 1024 * 1024 });
    assert.equal(big.status, 422);
    assert.equal(big.json?.code, 'documents.too_large');
    for (const r of [exe, dbl, mismatch, big]) assert.doesNotMatch(r.text, /report\.pdf|scan\.png|Test Patient/, 'no file name or PHI echoed');
    // The content-sniff half of TC-DOC-03 (bytes not the declared type) runs in the worker after an upload: BLOCKED with TC-DOC-01.
  });

  test('TC-DOC-04 deletion of a document under legal hold is refused with the reason recorded', async () => {
    const p = await newPatient();
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const doc = await fixtureDocument({ patientId: p.id, retentionUntil: '2000-01-01' });
    const hold = await mro.client.post(`/api/v1/documents/${doc}/legal-holds`, { action: 'placed', reason: 'QA-05 litigation hold (synthetic)' });
    assert.equal(hold.status, 201, `place hold ${hold.status} ${hold.text.slice(0, 200)}`);
    const req = await fd.client.post(`/api/v1/documents/${doc}/deletion-requests`, {});
    assert.equal(req.status, 409, `deletion request on a held document ${req.status} ${req.text.slice(0, 200)}`);
    assert.equal(req.json?.code, 'documents.legal_hold');
    const rows = await sql(`SELECT outcome, reason_recorded FROM documents.deletion_request WHERE document_id=$1`, [doc]);
    assert.equal(rows.rows[0]?.outcome, 'refused_legal_hold');
    assert.equal(rows.rows[0]?.reason_recorded, 'legal_hold');
    const d = await sql(`SELECT status FROM documents.document WHERE id=$1`, [doc]);
    assert.equal(d.rows[0].status, 'confirmed', 'the document is still on file');
    // a hold cannot be bypassed by a direct update either
    await assert.rejects(() => sql(`UPDATE documents.document SET status='deleted', deleted_at=now() WHERE id=$1`, [doc]));
  });

  test('TC-DOC-06 another patient\'s file ID is 404 and the attempt is logged', async () => {
    const owner = await newPatient();
    const other = await newPatient();
    const doc = await fixtureDocument({ patientId: owner.id });
    const r = await other.client.post(`/api/v1/documents/${doc}/download-url`, {});
    assert.equal(r.status, 404, `got ${r.status}`);
    const l = await other.client.get(`/api/v1/patients/${owner.id}/documents`);
    assert.ok([403, 404].includes(l.status), `listing someone else's documents is refused (${l.status})`);
    const logged = await until(async () => {
      const q = await sql(`SELECT count(*)::int n FROM audit.event WHERE actor_principal_id=$1 AND action='denied'`, [other.client.session.principalId]);
      return q.rows[0].n > 0;
    });
    assert.ok(logged, 'the refused attempt is audited as denied');
  });

  test('TC-DOC-07 deletion allowed only after the retention period and with no hold (D1 old, D2 young, D3 old+hold)', async () => {
    const p = await newPatient();
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const D1 = await fixtureDocument({ patientId: p.id, retentionUntil: '2000-01-01' });
    const D2 = await fixtureDocument({ patientId: p.id, retentionUntil: '2999-01-01' });
    const D3 = await fixtureDocument({ patientId: p.id, retentionUntil: '2000-01-01' });
    const h = await mro.client.post(`/api/v1/documents/${D3}/legal-holds`, { action: 'placed', reason: 'QA-05 hold on the old document' });
    assert.equal(h.status, 201);
    const r2 = await fd.client.post(`/api/v1/documents/${D2}/deletion-requests`, {});
    assert.equal(r2.status, 409);
    assert.equal(r2.json?.code, 'documents.retention', 'D2: retention period still open');
    const r1 = await fd.client.post(`/api/v1/documents/${D1}/deletion-requests`, {});
    assert.equal(r1.status, 201, `D1 request recorded ${r1.status} ${r1.text.slice(0, 200)}`);
    assert.equal(r1.json.outcome, 'pending');
    const dec = await mro.client.post(`/api/v1/deletion-requests/${r1.json.id}/decide`, {});
    assert.equal(dec.status, 200, `decide ${dec.status} ${dec.text.slice(0, 200)}`);
    assert.equal(dec.json.outcome, 'deleted');
    const r3 = await fd.client.post(`/api/v1/documents/${D3}/deletion-requests`, {});
    assert.equal(r3.status, 409);
    assert.equal(r3.json?.code, 'documents.legal_hold', 'D3: the hold wins over an ended retention period');
    const st = await sql(`SELECT id, status FROM documents.document WHERE id = ANY($1)`, [[D1, D2, D3]]);
    const by = Object.fromEntries(st.rows.map((x) => [x.id, x.status]));
    assert.deepEqual([by[D1], by[D2], by[D3]], ['deleted', 'confirmed', 'confirmed']);
    // Limitation: the retention period is a document column set at confirmation; the controllable clock of the written case is
    // replaced by writing retention_until directly. Retention from the setting (document_retention_years, no default; D-8) is
    // not asserted.
  });
});
