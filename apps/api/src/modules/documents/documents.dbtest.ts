// Real-database tests for BE-10 (documents) on PostgreSQL 17 with the real roles, migrations 1000-1003, the real Nest application and
// identity guard, and the worker's real jobs (scan, OCR, sweep) over an in-memory object store and a stub scanner:
//   TC-DOC-01..08 (automated parts), the merge during scanning (38.2 item 11), the database rules that no route can bypass, RLS, the
//   adapters, and the "no PHI in keys, URLs, audit rows or logs" checks.
// The store, the scanner and the OCR vendor are recording stubs: they prove OUR side of the interface, NOT a real malware scanner, object
// store or OCR vendor (C-01, C-10 are not provisioned; the real scan result tag and its timing are Unverified until staging).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/documents/documents.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ScopeSettings } from '@ehr/kernel';
import { pathToFileURL } from 'node:url';
import { DOCUMENTS_JOBS } from './jobs.js';
import { DocumentNotFoundError, InvalidTransitionError, NotAvailableError } from './errors.js';
import { documentsExportContributor } from './merge.js';
import { createDocumentsControllers } from './controller.js';
import { fileNameAllowed } from './service.js';
import {
  A1,
  B1,
  JPEG_WITH_EXIF,
  ORG,
  PATIENT_HOST,
  PDF,
  PNG_WITH_TEXT,
  call,
  keyOfUrl,
  repoRoot,
  STAFF_HOST,
  setupDocuments,
} from './testkit.js';
import type { DocKit, SeededSession } from './testkit.js';

const META = { requestId: '00000000-0000-7000-8000-00000000d0c5' } as const;
const EICAR_PDF = Buffer.from(
  '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n',
  'latin1',
);
const CANARY = 'CANARY-HOLD-REASON-9f3a';
const MB = 1024 * 1024;

describe('documents (BE-10) on PostgreSQL 17', () => {
  let t: DocKit;
  before(async () => {
    t = await setupDocuments('docs');
  });
  after(async () => {
    await t.close();
  });

  const doc = async (id: string): Promise<Record<string, unknown>> =>
    (
      await t.k.q(
        `SELECT d.*, v.object_key, v.bucket, v.scan_status, v.sha256, v.ocr_status, v.object_removed_at, v.patient_id AS v_patient
                    FROM documents.document d JOIN documents.document_version v ON v.document_id = d.id AND v.version = d.current_version
                   WHERE d.id = $1`,
        [id],
      )
    )[0] as Record<string, unknown>;
  const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
  const etag = async (id: string): Promise<string> =>
    `W/"${String((await doc(id))['row_version'])}"`;
  const scope = (s: SeededSession, locations: string[] = [A1]): ScopeSettings => ({
    audience: 'staff',
    realm: 'google',
    orgId: ORG,
    principalId: s.seeded.principalId,
    personId: s.seeded.personId,
    locationIds: locations,
  });
  /** Moves a document's retention date without going through the state changes the triggers guard (test setup only). */
  const setRetention = async (id: string, sql: string): Promise<void> => {
    await t.k.sa.query('BEGIN');
    try {
      await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
      await t.k.sa.query(`UPDATE documents.document SET retention_until = ${sql} WHERE id = $1`, [
        id,
      ]);
      await t.k.sa.query('COMMIT');
    } catch (e) {
      await t.k.sa.query('ROLLBACK');
      throw e;
    }
  };
  const holdBody = (
    action: 'placed' | 'released',
    reason = `Litigation hold ${CANARY}`,
  ): Record<string, unknown> => ({ action, reason });
  const attempt = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await fn();
      return undefined;
    } catch (e) {
      return String((e as { code?: unknown }).code);
    }
  };

  test('the job types are the same on both sides, each declares on_merged where it carries a patient, and the queue knows them', async () => {
    const w = (await import(
      pathToFileURL(`${repoRoot}apps/worker/dist/jobs/documents/jobs.js`).href
    )) as { DOCUMENTS_JOBS: unknown; DOCUMENTS_CRONTAB: string };
    assert.deepEqual(w.DOCUMENTS_JOBS, DOCUMENTS_JOBS);
    for (const j of DOCUMENTS_JOBS)
      assert.ok(!j.carriesPatientIds || j.onMerged === 'resolve', j.name);
    assert.deepEqual(
      DOCUMENTS_JOBS.map((j) => j.name),
      ['documents.await_scan', 'documents.ocr_suggest', 'documents.retention_sweep'],
    );
    const types = await t.k.q(
      `SELECT task_identifier, api_enqueue FROM queue_api.task_type WHERE task_identifier LIKE 'documents.%' ORDER BY 1`,
    );
    assert.deepEqual(
      types.map((x) => [x['task_identifier'], x['api_enqueue']]),
      [
        ['documents.await_scan', true],
        ['documents.ocr_suggest', true],
        ['documents.retention_sweep', false],
      ],
    );
    assert.match(w.DOCUMENTS_CRONTAB, /documents\.retention_sweep$/);
  });

  // ===== TC-DOC-01 ================================================================================================
  test('TC-DOC-01: nobody opens an upload until it is scanned clean; then staff classify and confirm it', async () => {
    const { patientId, session } = await t.mkPatient(1);
    const u = await t.uploadAs(session, patientId, PDF);
    const url = String(u.ticket['uploadUrl']);
    // The upload goes to the object store (quarantine bucket, random key), not through the API (CN-12).
    assert.match(
      url,
      /^https:\/\/objects\.invalid\/quarantine\/q\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
    assert.deepEqual(u.ticket['uploadHeaders'], {
      'Content-Type': 'application/pdf',
      'Content-Length': String(PDF.length),
    });
    assert.equal((await doc(u.documentId))['status'], 'scanning');
    assert.equal((await doc(u.documentId))['bucket'], 'quarantine');

    // While it is scanning nobody gets a URL: the patient, nor staff.
    const refused = await t.pcall(
      session,
      'POST',
      `/api/v1/documents/${u.documentId}/download-url`,
    );
    assert.equal(refused.status, 409);
    assert.equal(code(refused), 'documents.not_available');
    const staff = scope(t.desk);
    await assert.rejects(
      t.as(staff, (tx) => t.svc.downloadUrl(tx, META, u.documentId)),
      NotAvailableError,
    );

    // The scan has not finished: the job polls again and the document stays scanning.
    const payload = { documentId: u.documentId, version: 1, patientId };
    assert.equal(await t.worker.runAwaitScan(payload), 'polling');
    assert.equal((await doc(u.documentId))['status'], 'scanning');
    // A document completed twice is the same answer and one job (idempotent complete).
    const again = await t.pcall(
      session,
      'POST',
      `/api/v1/document-uploads/${u.documentId}/complete`,
      {},
    );
    assert.equal(again.status, 202);

    // The verdict arrives: the file is copied to the clean bucket under a NEW random key and the document is clean.
    t.scanner.release(u.key);
    assert.equal(await t.worker.runAwaitScan(payload), 'clean');
    const d = await doc(u.documentId);
    assert.equal(d['status'], 'clean');
    assert.equal(d['bucket'], 'clean');
    assert.match(String(d['object_key']), /^c\/[0-9a-f]{32}$/);
    assert.notEqual(d['object_key'], u.key);
    assert.equal((d['sha256'] as Buffer).length, 32);
    assert.equal(t.store.has('quarantine', u.key), false);
    assert.equal(t.store.has('clean', String(d['object_key'])), true);
    assert.equal(d['ocr_status'], 'pending');

    // Now the owner gets a 60-second URL for the clean object; staff too.
    const ok = await t.pcall(session, 'POST', `/api/v1/documents/${u.documentId}/download-url`);
    assert.equal(ok.status, 200);
    const got = ok.json();
    assert.match(
      String(got['url']),
      /^https:\/\/objects\.invalid\/clean\/c\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
    const ttl = (Date.parse(String(got['expiresAt'])) - Date.now()) / 1000;
    assert.ok(ttl > 50 && ttl <= 61, `URL lives about 60 s, got ${ttl}`);
    assert.equal(
      (await t.as(staff, (tx) => t.svc.downloadUrl(tx, META, u.documentId))).url.includes(
        '/clean/',
      ),
      true,
    );

    // The patient sees the document with its status; a patient cannot classify or confirm (a staff permission, realm).
    const list = await t.pcall(session, 'GET', `/api/v1/patients/${patientId}/documents`);
    assert.equal(list.status, 200);
    const item = (list.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === u.documentId,
    );
    assert.equal(item?.['status'], 'clean');
    assert.equal(item?.['suggestedClassification'], undefined, 'the suggestion is staff-only');
    // Staff-only routes exist on the staff host only (INT03-F21-O1): the patient host has no such route (404) and a patient session
    // sent to the staff host fails the realm check (403).
    const cls = [
      ['PUT', `/api/v1/documents/${u.documentId}/classification`, { classification: 'consent' }],
      ['POST', `/api/v1/documents/${u.documentId}/confirm`, {}],
    ] as const;
    for (const [m, path, b] of cls) {
      const h = { 'if-match': await etag(u.documentId) };
      assert.equal((await t.pcall(session, m, path, b, h)).status, 404, `${m} ${path} on my.`);
      assert.equal((await t.scall(session, m, path, b, h)).status, 403, `${m} ${path} as patient`);
    }

    // Staff classify (stale If-Match is 412), then confirm; a confirmed document is not re-classified.
    const stale = await t.scall(
      t.records,
      'PUT',
      `/api/v1/documents/${u.documentId}/classification`,
      { classification: 'insurance_card' },
      { 'if-match': 'W/"1"' },
    );
    assert.equal(stale.status, 412);
    const cl = await t.scall(
      t.records,
      'PUT',
      `/api/v1/documents/${u.documentId}/classification`,
      { classification: 'insurance_card' },
      { 'if-match': await etag(u.documentId) },
    );
    assert.equal(cl.status, 200);
    assert.equal(cl.json()['classification'], 'insurance_card');
    const nope = await t.scall(t.records, 'POST', `/api/v1/documents/${u.documentId}/confirm`, {});
    assert.equal(nope.status, 428, 'If-Match is required');
    const cf = await t.scall(
      t.records,
      'POST',
      `/api/v1/documents/${u.documentId}/confirm`,
      {},
      { 'if-match': await etag(u.documentId) },
    );
    assert.equal(cf.status, 200);
    assert.equal(cf.json()['status'], 'confirmed');
    const c = await doc(u.documentId);
    assert.equal(c['confirmed_by'], t.records.seeded.principalId);
    assert.equal(
      c['retention_until'],
      null,
      'no retention setting: no date (D-8 open), fail closed',
    );
    const late = await t.scall(
      t.records,
      'PUT',
      `/api/v1/documents/${u.documentId}/classification`,
      { classification: 'consent' },
      { 'if-match': await etag(u.documentId) },
    );
    assert.equal(late.status, 409);
    assert.equal(code(late), 'documents.invalid_transition');
    // The download was audited (BR-33, 29.2).
    const audited = await t.k.q(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'download' AND resource_type = 'documents.document' AND resource_id = $1`,
      [u.documentId],
    );
    assert.ok(Number(audited[0]?.['n']) >= 2);
  });

  test('INT03-F21-O1: the staff variants of the four shared paths are served on the staff host, audited, and never cross hosts', async () => {
    const { patientId, session } = await t.mkPatient(31);
    const up = `/api/v1/patients/${patientId}/document-uploads`;
    const body = {
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      classification: 'consent',
    };
    // No session: 401. A staff role without documents.upload: 403. Staff of another location (patient not in scope): 404 (CN-04).
    const anon = await t.scall({ ...t.desk, cookie: '' } as SeededSession, 'POST', up, body);
    assert.equal(anon.status, 401);
    assert.equal((await t.scall(t.records, 'POST', up, body)).status, 403);
    assert.equal(
      (await t.scall(t.mr2, 'GET', `/api/v1/patients/${patientId}/documents`)).status,
      404,
    );

    // Front desk (documents.upload + documents.read) uploads for the patient on the staff host.
    const c = await t.scall(t.desk, 'POST', up, body);
    assert.equal(c.status, 201, c.body);
    const ticket = c.json();
    const documentId = String(ticket['documentId']);
    const { key } = keyOfUrl(String(ticket['uploadUrl']));
    t.store.upload(key, PDF, 'application/pdf');
    const done = await t.scall(
      t.desk,
      'POST',
      `/api/v1/document-uploads/${documentId}/complete`,
      {},
    );
    assert.equal(done.status, 202, done.body);
    assert.equal((await doc(documentId))['upload_channel'], 'staff');

    // Not downloadable until scanned clean (409), then 200 and audited as download.
    const dl = `/api/v1/documents/${documentId}/download-url`;
    assert.equal((await t.scall(t.desk, 'POST', dl)).status, 409);
    t.scanner.release(key);
    assert.equal(await t.worker.runAwaitScan({ documentId, version: 1, patientId }), 'clean');
    const ok = await t.scall(t.desk, 'POST', dl);
    assert.equal(ok.status, 200, ok.body);
    assert.match(String(ok.json()['url']), /\/clean\/c\/[0-9a-f]{32}\?exp=\d+&sig=/);
    const downloads = await t.k.q(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'download' AND resource_type = 'documents.document' AND resource_id = $1`,
      [documentId],
    );
    assert.equal(Number(downloads[0]?.['n']), 1);

    // The staff list carries the staff-only fields and is audited (patient and action only).
    const before = await t.k.q(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'view' AND resource_type = 'documents.document' AND patient_id = $1`,
      [patientId],
    );
    const list = await t.scall(t.records, 'GET', `/api/v1/patients/${patientId}/documents`);
    assert.equal(list.status, 200, list.body);
    const item = (list.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === documentId,
    );
    assert.equal(item?.['status'], 'clean');
    assert.equal(
      (list.json()['patientBanner'] as Record<string, unknown> | undefined)?.['patientId'],
      patientId,
      'the staff list carries the patient banner (28.2)',
    );
    assert.ok(item !== undefined && 'onLegalHold' in item && 'retentionUntil' in item);
    const after = await t.k.q(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'view' AND resource_type = 'documents.document' AND patient_id = $1`,
      [patientId],
    );
    assert.equal(Number(after[0]?.['n']), Number(before[0]?.['n']) + 1);

    // Cross-host: a staff session sent to the patient host and a patient session on the staff host are refused (403);
    // the patient's own list stays the patient variant (no staff-only fields); an unknown host reaches no route (404).
    const listPath = `/api/v1/patients/${patientId}/documents`;
    assert.equal((await t.pcall(t.desk, 'GET', listPath)).status, 403);
    assert.equal((await t.scall(session, 'GET', listPath)).status, 403);
    assert.equal((await t.scall(session, 'POST', up, body)).status, 403);
    assert.equal((await t.scall(session, 'POST', dl)).status, 403);
    // Via X-Forwarded-Host from a trusted (loopback) peer: routing uses req.hostname, so the request lands on the other host's
    // declaration and the realm check refuses it.
    assert.equal(
      (await t.scall(t.desk, 'GET', listPath, undefined, { 'x-forwarded-host': PATIENT_HOST }))
        .status,
      403,
    );
    assert.equal(
      (await t.pcall(session, 'GET', listPath, undefined, { 'x-forwarded-host': STAFF_HOST }))
        .status,
      403,
    );
    const mine = await t.pcall(session, 'GET', listPath);
    assert.equal(mine.status, 200);
    assert.equal('patientBanner' in mine.json(), false, 'no banner on the patient host');
    assert.equal(
      (mine.json()['items'] as Record<string, unknown>[]).every((x) => !('onLegalHold' in x)),
      true,
    );
    const stray = await call(t.k.base, 'GET', listPath, {
      host: 'other.example.test',
      cookie: t.desk.cookie,
    });
    assert.equal(stray.status, 404);
  });

  test('INT03-F21-O1: the controllers refuse empty or equal hosts (also differing in letter case)', () => {
    const banner = { bannerFor: () => Promise.resolve(undefined) };
    const mk = (staff: string, patient: string): unknown =>
      createDocumentsControllers({
        db: {} as never,
        documents: {} as never,
        banner,
        hosts: { staff, patient },
      });
    assert.throws(() => mk('', PATIENT_HOST));
    assert.throws(() => mk(STAFF_HOST, ''));
    assert.throws(() => mk('a.example.test', 'a.example.test'));
    assert.throws(() => mk('A.example.test', 'a.example.test'));
    assert.doesNotThrow(() => mk(STAFF_HOST, PATIENT_HOST));
  });

  test('an upload request is idempotent: the same key is the same document and one row', async () => {
    const { patientId, session } = await t.mkPatient(2);
    const key = crypto.randomUUID();
    const body = { contentType: 'application/pdf', sizeBytes: 1000 };
    const mk = (): Promise<Awaited<ReturnType<DocKit['pcall']>>> =>
      t.pcall(session, 'POST', `/api/v1/patients/${patientId}/document-uploads`, body, {
        'idempotency-key': key,
      });
    const a = await mk();
    const b = await mk();
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers['idempotent-replay'], 'true');
    assert.equal(a.json()['documentId'], b.json()['documentId']);
    assert.equal(
      Number(
        (
          await t.k.q(`SELECT count(*)::int AS n FROM documents.document WHERE patient_id = $1`, [
            patientId,
          ])
        )[0]?.['n'],
      ),
      1,
    );
  });

  // ===== TC-DOC-02 ================================================================================================
  test('TC-DOC-02: an infected file is quarantined, never served, and operations are told (stub verdict, NOT a real scanner)', async () => {
    const { patientId, session } = await t.mkPatient(3);
    const u = await t.uploadAs(session, patientId, EICAR_PDF);
    t.scanner.release(u.key);
    const before = t.alerts.list.length;
    assert.equal(
      await t.worker.runAwaitScan({ documentId: u.documentId, version: 1, patientId }),
      'quarantined',
    );
    const d = await doc(u.documentId);
    assert.equal(d['status'], 'quarantined');
    assert.equal(d['scan_status'], 'infected');
    assert.equal(d['bucket'], 'quarantine');
    assert.equal(t.store.has('quarantine', u.key), true, 'kept for the investigation');
    assert.equal(
      [...t.store.objects.keys()].some(
        (k) => k.startsWith('clean/') && t.store.objects.get(k)?.body.includes('EICAR'),
      ),
      false,
    );
    assert.ok(
      t.alerts.list
        .slice(before)
        .some((a) => a.kind === 'quarantined' && a.documentId === u.documentId),
      'operations alert',
    );
    // The uploader is told: the event is published in the transaction that quarantines (a handler registers for it at composition).
    const evt = await t.k.q(
      `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier = 'sink.on_quarantined' AND j.payload->>'documentId' = $1`,
      [u.documentId],
    );
    assert.equal(Number(evt[0]?.['n']), 1);
    const row = await t.k.q(
      `SELECT job_id, realm, audience FROM audit.event WHERE resource_id = $1 AND action = 'update' ORDER BY occurred_at DESC LIMIT 1`,
      [u.documentId],
    );
    assert.equal(row[0]?.['audience'], 'system');

    // Nobody opens it: the owner, a clinician, anyone.
    const r = await t.pcall(session, 'POST', `/api/v1/documents/${u.documentId}/download-url`);
    assert.equal(r.status, 409);
    await assert.rejects(
      t.as(scope(t.records), (tx) => t.svc.downloadUrl(tx, META, u.documentId)),
      NotAvailableError,
    );

    // The database refuses to let anyone make it clean: not staff, not the API, not even a hand-written update.
    assert.equal(
      await attempt(() =>
        t.as(scope(t.records), (tx) =>
          tx.query(`UPDATE documents.document SET status = 'clean' WHERE id = $1`, [u.documentId]),
        ),
      ),
      'PS001',
    );
    assert.equal(
      await attempt(() =>
        t.as(scope(t.records), (tx) =>
          tx.query(
            `UPDATE documents.document_version SET scan_status = 'clean' WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
      ),
      '42501',
    );
    assert.equal((await doc(u.documentId))['status'], 'quarantined');
  });

  // ===== TC-DOC-03 ================================================================================================
  test('TC-DOC-03: oversize, mismatched-type and double-extension uploads are refused with safe errors', async () => {
    const { patientId, session } = await t.mkPatient(4);
    const up = (body: Record<string, unknown>): Promise<Awaited<ReturnType<DocKit['pcall']>>> =>
      t.pcall(session, 'POST', `/api/v1/patients/${patientId}/document-uploads`, body);
    const big = await up({ contentType: 'application/pdf', sizeBytes: 21 * MB });
    assert.equal(big.status, 422);
    assert.equal(code(big), 'documents.too_large');
    const html = await up({ contentType: 'text/html', sizeBytes: 100 });
    assert.equal(html.status, 422);
    assert.equal(code(html), 'documents.type_not_allowed');
    for (const fileName of [
      'report.pdf.exe',
      'invoice.exe.pdf',
      'scan.png',
      'a/b.pdf',
      'noextension',
      '.pdf',
      'x.pdf ',
    ])
      assert.equal(
        code(await up({ contentType: 'application/pdf', sizeBytes: 100, fileName })),
        'documents.type_not_allowed',
        fileName,
      );
    assert.equal(
      (await up({ contentType: 'application/pdf', sizeBytes: 100, fileName: 'letter.PDF' })).status,
      201,
    );
    assert.equal(
      code(await up({ contentType: 'application/pdf', sizeBytes: 0 })),
      'kernel.validation_failed',
    );
    assert.equal(
      code(
        await up({
          contentType: 'application/pdf',
          sizeBytes: 10,
          classification: 'clinical_photo',
        }),
      ),
      'kernel.validation_failed',
    );
    for (const r of [big, html]) {
      const text = r.body;
      assert.ok(!/Given4|Family4|person4@/.test(text), 'no PHI in the message');
      assert.deepEqual(Object.keys(r.json()).sort(), [
        'code',
        'requestId',
        'retryable',
        'status',
        'title',
        'type',
      ]);
    }
    assert.equal(fileNameAllowed('a.jpeg', 'image/jpeg'), true);
    assert.equal(fileNameAllowed('a.jpeg', 'image/png'), false);

    // Bytes that are not what the upload URL fixed are refused when the scan looks at them (and the bytes decide, not the header).
    const png = await t.uploadAs(session, patientId, PNG_WITH_TEXT, {
      contentType: 'application/pdf',
    });
    t.scanner.release(png.key);
    const before = t.alerts.list.length;
    assert.equal(
      await t.worker.runAwaitScan({ documentId: png.documentId, version: 1, patientId }),
      'quarantined',
    );
    assert.ok(t.alerts.list.slice(before).some((a) => a.kind === 'rejected_file'));
    assert.equal((await doc(png.documentId))['status'], 'quarantined');
    // A file whose size is not the declared size, and a broken image, are refused the same way.
    const wrongSize = await t.uploadAs(session, patientId, PDF, { put: false });
    t.store.upload(wrongSize.key, Buffer.concat([PDF, Buffer.from('extra')]), 'application/pdf');
    t.scanner.release(wrongSize.key);
    assert.equal(
      await t.worker.runAwaitScan({ documentId: wrongSize.documentId, version: 1, patientId }),
      'quarantined',
    );
    const broken = await t.uploadAs(session, patientId, PNG_WITH_TEXT.subarray(0, 40), {
      contentType: 'image/png',
    });
    t.scanner.release(broken.key);
    assert.equal(
      await t.worker.runAwaitScan({ documentId: broken.documentId, version: 1, patientId }),
      'quarantined',
    );

    // A clean image leaves with its metadata removed (SEC-D-08): no text chunk, no EXIF.
    const img = await t.uploadAs(session, patientId, PNG_WITH_TEXT, { contentType: 'image/png' });
    t.scanner.release(img.key);
    assert.equal(
      await t.worker.runAwaitScan({ documentId: img.documentId, version: 1, patientId }),
      'clean',
    );
    const stored = t.store.objects.get(
      `clean/${String((await doc(img.documentId))['object_key'])}`,
    );
    assert.ok(
      stored !== undefined &&
        !stored.body.includes('CANARY-EXIF-LOCATION') &&
        stored.contentType === 'image/png',
    );
    const jpg = await t.uploadAs(session, patientId, JPEG_WITH_EXIF, { contentType: 'image/jpeg' });
    t.scanner.release(jpg.key);
    assert.equal(
      await t.worker.runAwaitScan({ documentId: jpg.documentId, version: 1, patientId }),
      'clean',
    );
    const stored2 = t.store.objects.get(
      `clean/${String((await doc(jpg.documentId))['object_key'])}`,
    );
    assert.ok(stored2 !== undefined && !stored2.body.includes('Exif'));
  });

  test('uploads per day follow the setting (31.1)', async () => {
    const { patientId, session } = await t.mkPatient(5);
    await t.setSetting('uploads_per_day', 2);
    try {
      const up = (): Promise<Awaited<ReturnType<DocKit['pcall']>>> =>
        t.pcall(session, 'POST', `/api/v1/patients/${patientId}/document-uploads`, {
          contentType: 'application/pdf',
          sizeBytes: 10,
        });
      assert.equal((await up()).status, 201);
      assert.equal((await up()).status, 201);
      const third = await up();
      assert.equal(third.status, 429);
      assert.equal(code(third), 'kernel.rate_limited');
    } finally {
      await t.k.sa.query(`DELETE FROM kernel.setting WHERE key = 'uploads_per_day'`);
    }
  });

  // ===== TC-DOC-04 ================================================================================================
  test('TC-DOC-04: a deletion request under legal hold is refused with the reason recorded', async () => {
    const { patientId, session } = await t.mkPatient(6);
    const id = await t.confirmedDocument(session, patientId);
    const short = await t.scall(t.records, 'POST', `/api/v1/documents/${id}/legal-holds`, {
      action: 'placed',
      reason: 'short',
    });
    assert.equal(short.status, 422);
    assert.equal(
      (await t.scall(t.desk, 'POST', `/api/v1/documents/${id}/legal-holds`, holdBody('placed')))
        .status,
      403,
      'front desk may not manage holds',
    );
    const h = await t.scall(
      t.records,
      'POST',
      `/api/v1/documents/${id}/legal-holds`,
      holdBody('placed'),
    );
    assert.equal(h.status, 201);
    // The same action again changes nothing: refused, not a second row.
    const dup = await t.scall(
      t.records,
      'POST',
      `/api/v1/documents/${id}/legal-holds`,
      holdBody('placed'),
    );
    assert.equal(dup.status, 409);

    const req = await t.scall(t.desk, 'POST', `/api/v1/documents/${id}/deletion-requests`, {});
    assert.equal(req.status, 409);
    assert.equal(code(req), 'documents.legal_hold');
    const recorded = await t.k.q(
      `SELECT outcome, reason_recorded, decided_at FROM documents.deletion_request WHERE document_id = $1`,
      [id],
    );
    assert.equal(recorded.length, 1, 'the refusal is committed, not rolled back with the answer');
    assert.equal(recorded[0]?.['outcome'], 'refused_legal_hold');
    assert.equal(recorded[0]?.['reason_recorded'], 'legal_hold');
    assert.ok(recorded[0]?.['decided_at'] !== null);
    assert.equal((await doc(id))['status'], 'confirmed');
    // The recorded request is kept: no later update changes it.
    assert.equal(
      await attempt(() =>
        t.k.sa.query(`UPDATE documents.deletion_request SET outcome = 'pending'`),
      ),
      'PS001',
    );

    // The hold is append-only: its rows are never updated or deleted, by anyone.
    assert.equal(
      await attempt(() =>
        t.k.sa.query(`UPDATE documents.legal_hold SET reason = 'changed to something else'`),
      ),
      'PS001',
    );
    assert.equal(await attempt(() => t.k.sa.query(`DELETE FROM documents.legal_hold`)), 'PS001');
    // Released, the request now meets the retention rule instead (no retention date: refused, fail closed).
    assert.equal(
      (
        await t.scall(
          t.records,
          'POST',
          `/api/v1/documents/${id}/legal-holds`,
          holdBody('released'),
        )
      ).status,
      201,
    );
    const again = await t.scall(t.desk, 'POST', `/api/v1/documents/${id}/deletion-requests`, {});
    assert.equal(again.status, 409);
    assert.equal(code(again), 'documents.retention');
  });

  // ===== TC-DOC-05 / 06 ===========================================================================================
  test("TC-DOC-05: URLs are bound to one object, one method, one size and one moment; one patient cannot read another's file", async () => {
    const { patientId, session } = await t.mkPatient(7);
    const other = await t.mkPatient(8);
    const u = await t.uploadAs(session, patientId, PDF);
    const url = String(u.ticket['uploadUrl']);
    const now = new Date();
    assert.equal(
      t.presigner.verify(
        'PUT',
        url,
        { contentType: 'application/pdf', contentLength: PDF.length },
        now,
      ),
      true,
    );
    assert.equal(
      t.presigner.verify(
        'PUT',
        url,
        { contentType: 'application/pdf', contentLength: PDF.length + 1 },
        now,
      ),
      false,
      'another size',
    );
    assert.equal(
      t.presigner.verify('PUT', url, { contentType: 'image/png', contentLength: PDF.length }, now),
      false,
      'another type',
    );
    assert.equal(
      t.presigner.verify('GET', url, { contentType: 'application/pdf' }, now),
      false,
      'another method',
    );
    assert.equal(
      t.presigner.verify(
        'PUT',
        url.replace('/q/', '/q/0'),
        { contentType: 'application/pdf', contentLength: PDF.length },
        now,
      ),
      false,
      'another object',
    );
    assert.equal(
      t.presigner.verify(
        'PUT',
        url,
        { contentType: 'application/pdf', contentLength: PDF.length },
        new Date(now.getTime() + 301_000),
      ),
      false,
      'expired after 5 minutes',
    );
    assert.equal(
      t.presigner.verify(
        'PUT',
        url,
        { contentType: 'application/pdf', contentLength: PDF.length },
        new Date(now.getTime() + 290_000),
      ),
      true,
    );

    t.scanner.release(u.key);
    await t.worker.runAwaitScan({ documentId: u.documentId, version: 1, patientId });
    const dl = (
      await t.pcall(session, 'POST', `/api/v1/documents/${u.documentId}/download-url`)
    ).json();
    const durl = String(dl['url']);
    const ct = { contentType: 'application/pdf' };
    // The download URL is minted at the service's clock, after `now` was read for the upload URL; the 60-second bound is checked
    // against a reading taken once the URL exists, so a second boundary crossed in between (a slow or loaded run) cannot move it.
    const gnow = new Date();
    assert.equal(t.presigner.verify('GET', durl, ct, gnow), true);
    assert.equal(
      t.presigner.verify('GET', durl, ct, new Date(gnow.getTime() + 61_000)),
      false,
      'a download URL lives 60 seconds',
    );
    const { key } = keyOfUrl(durl);
    assert.equal(
      t.presigner.verify('GET', durl.replace(key, 'c/' + 'a'.repeat(32)), ct, gnow),
      false,
      'not another file',
    );
    // The other patient asks for it by ID: 404 (TC-DOC-06), and the denial is logged.
    const denied0 = Number(
      (
        await t.k.q(
          `SELECT count(*)::int AS n FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible'`,
        )
      )[0]?.['n'],
    );
    const r = await t.pcall(
      other.session,
      'POST',
      `/api/v1/documents/${u.documentId}/download-url`,
    );
    assert.equal(r.status, 404);
    assert.equal(code(r), 'kernel.not_found');
    const denied1 = Number(
      (
        await t.k.q(
          `SELECT count(*)::int AS n FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible'`,
        )
      )[0]?.['n'],
    );
    assert.ok(denied1 > denied0, 'the refusal is audited (TC-DOC-06)');
    // Nor can they list, complete or read it through the service under their own scope.
    const own = await t.pcall(other.session, 'GET', `/api/v1/patients/${patientId}/documents`);
    assert.equal(own.status, 404);
    assert.equal(
      (
        await t.pcall(
          other.session,
          'POST',
          `/api/v1/document-uploads/${u.documentId}/complete`,
          {},
        )
      ).status,
      404,
    );
  });

  // ===== TC-DOC-07 ================================================================================================
  test('TC-DOC-07: deletion is allowed only after the retention period and with no hold, through a request that is decided', async () => {
    await t.setSetting('document_retention_years', 7);
    const { patientId, session } = await t.mkPatient(9);
    try {
      const d1 = await t.confirmedDocument(session, patientId);
      const d2 = await t.confirmedDocument(session, patientId);
      const d3 = await t.confirmedDocument(session, patientId);
      const today = new Date();
      const expect = `${today.getUTCFullYear() + 7}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
      assert.equal(
        String(
          (
            await t.k.q(`SELECT retention_until::text AS d FROM documents.document WHERE id = $1`, [
              d2,
            ])
          )[0]?.['d'],
        ),
        expect,
        'confirm sets the retention date from the setting',
      );
      await setRetention(d1, `current_date - 1`);
      await setRetention(d3, `current_date - 1`);

      // D2, younger than the period: refused, recorded.
      const r2 = await t.scall(t.desk, 'POST', `/api/v1/documents/${d2}/deletion-requests`, {});
      assert.equal(r2.status, 409);
      assert.equal(code(r2), 'documents.retention');
      assert.equal(
        (
          await t.k.q(`SELECT outcome FROM documents.deletion_request WHERE document_id = $1`, [d2])
        )[0]?.['outcome'],
        'refused_retention',
      );
      assert.equal((await doc(d2))['status'], 'confirmed');

      // D1, older and with no hold: the request is accepted; deciding it deletes the record (not the audit trail).
      const auditBefore = Number(
        (
          await t.k.q(`SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1`, [
            patientId,
          ])
        )[0]?.['n'],
      );
      const r1 = await t.scall(t.desk, 'POST', `/api/v1/documents/${d1}/deletion-requests`, {});
      assert.equal(r1.status, 201);
      assert.equal(r1.json()['outcome'], 'pending');
      const reqId = String(r1.json()['id']);
      assert.equal(
        (await t.scall(t.desk, 'POST', `/api/v1/deletion-requests/${reqId}/decide`, {})).status,
        403,
        'a front desk member cannot decide',
      );
      const dec = await t.scall(t.records, 'POST', `/api/v1/deletion-requests/${reqId}/decide`, {});
      assert.equal(dec.status, 200);
      assert.equal(dec.json()['outcome'], 'deleted');
      const gone = await doc(d1);
      assert.equal(gone['status'], 'deleted');
      assert.ok(gone['deleted_at'] !== null);
      const rep = await t.scall(t.records, 'POST', `/api/v1/deletion-requests/${reqId}/decide`, {});
      assert.equal(rep.json()['outcome'], 'deleted', 'a decided request answers the same again');
      assert.ok(
        Number(
          (
            await t.k.q(`SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1`, [
              patientId,
            ])
          )[0]?.['n'],
        ) > auditBefore,
        'the audit trail only grows',
      );
      // Nobody gets a URL for a deleted document; the sweep removes the stored object.
      const keyOf = String(gone['object_key']);
      assert.equal(t.store.has('clean', keyOf), true);
      assert.equal(
        (await t.pcall(session, 'POST', `/api/v1/documents/${d1}/download-url`)).status,
        404,
        'a patient no longer sees it',
      );
      await assert.rejects(
        t.as(scope(t.records), (tx) => t.svc.downloadUrl(tx, META, d1)),
        NotAvailableError,
      );
      const sweep = await t.worker.runRetentionSweep();
      assert.equal(sweep.failed, 0);
      assert.ok(sweep.removed >= 1);
      assert.equal(t.store.has('clean', keyOf), false);
      assert.ok((await doc(d1))['object_removed_at'] !== null);
      assert.equal((await t.worker.runRetentionSweep()).removed, 0, 'the sweep does the work once');
      // A hold cannot be placed on a deleted document.
      assert.equal(
        (
          await t.scall(
            t.records,
            'POST',
            `/api/v1/documents/${d1}/legal-holds`,
            holdBody('placed'),
          )
        ).status,
        409,
      );

      // D3, older but on legal hold: refused for the hold.
      assert.equal(
        (
          await t.scall(
            t.records,
            'POST',
            `/api/v1/documents/${d3}/legal-holds`,
            holdBody('placed'),
          )
        ).status,
        201,
      );
      const r3 = await t.scall(t.desk, 'POST', `/api/v1/documents/${d3}/deletion-requests`, {});
      assert.equal(r3.status, 409);
      assert.equal(code(r3), 'documents.legal_hold');
      assert.equal((await doc(d3))['status'], 'confirmed');

      // A hold placed between the request and the decision is seen at the decision.
      const d4 = await t.confirmedDocument(session, patientId);
      await setRetention(d4, `current_date - 1`);
      const r4 = await t.scall(t.desk, 'POST', `/api/v1/documents/${d4}/deletion-requests`, {});
      assert.equal(r4.status, 201);
      assert.equal(
        (
          await t.scall(
            t.records,
            'POST',
            `/api/v1/documents/${d4}/legal-holds`,
            holdBody('placed'),
          )
        ).status,
        201,
      );
      const dec4 = await t.scall(
        t.records,
        'POST',
        `/api/v1/deletion-requests/${String(r4.json()['id'])}/decide`,
        {},
      );
      assert.equal(dec4.status, 409);
      assert.equal(code(dec4), 'documents.legal_hold');
      assert.equal(
        (
          await t.k.q(`SELECT outcome FROM documents.deletion_request WHERE id = $1`, [
            String(r4.json()['id']),
          ])
        )[0]?.['outcome'],
        'refused_legal_hold',
      );
      assert.equal((await doc(d4))['status'], 'confirmed');

      // The database holds even when a route would not: a hand-written deletion (no decided request, or a retained or held document)
      // is refused, so no code path of this module or of a later one can delete what BR-29 forbids.
      const staff = scope(t.records);
      for (const id of [d2, d3, d4])
        assert.ok(
          ['PS001', 'PS002'].includes(
            String(
              await attempt(() =>
                t.as(staff, (tx) =>
                  tx.query(
                    `UPDATE documents.document SET status = 'deleted', deleted_at = now() WHERE id = $1`,
                    [id],
                  ),
                ),
              ),
            ),
          ),
          id,
        );
      assert.equal((await doc(d2))['status'], 'confirmed');
    } finally {
      await t.k.sa.query(`DELETE FROM kernel.setting WHERE key = 'document_retention_years'`);
    }
  });

  // ===== TC-DOC-08 ================================================================================================
  test('TC-DOC-08: with the scanner down the file stays unavailable, the failure is visible, nothing bypasses it (stub outage, NOT the real service)', async () => {
    const { patientId, session } = await t.mkPatient(10);
    const u = await t.uploadAs(session, patientId, PDF);
    t.scanner.release(u.key);
    t.scanner.outage = true;
    const before = t.alerts.list.length;
    const payload = { documentId: u.documentId, version: 1, patientId };
    assert.equal(await t.worker.runAwaitScan(payload), 'error');
    const d = await doc(u.documentId);
    assert.equal(d['status'], 'scanning');
    assert.equal(d['scan_status'], 'error', 'a visible failure');
    assert.ok(
      t.alerts.list
        .slice(before)
        .some((a) => a.kind === 'scan_error' && a.documentId === u.documentId),
    );
    assert.equal(
      (await t.pcall(session, 'POST', `/api/v1/documents/${u.documentId}/download-url`)).status,
      409,
    );
    await assert.rejects(
      t.as(scope(t.desk), (tx) => t.svc.downloadUrl(tx, META, u.documentId)),
      NotAvailableError,
    );
    // It tries again (a second run is still an error and does not alert twice).
    assert.equal(await t.worker.runAwaitScan(payload), 'error');
    assert.equal(t.alerts.list.slice(before).filter((a) => a.kind === 'scan_error').length, 1);
    // The scanner returns and the file is scanned.
    t.scanner.outage = false;
    assert.equal(await t.worker.runAwaitScan(payload), 'clean');
    assert.equal((await doc(u.documentId))['status'], 'clean');
    assert.equal(
      (await t.pcall(session, 'POST', `/api/v1/documents/${u.documentId}/download-url`)).status,
      200,
    );
  });

  test('a scan that never finishes: the version shows an error after 30 minutes, operations are alerted, and the job keeps trying', async () => {
    const { patientId, session } = await t.mkPatient(11);
    const u = await t.uploadAs(session, patientId, PDF);
    const payload = { documentId: u.documentId, version: 1, patientId };
    t.setNow(() => new Date(Date.now() + 31 * 60_000));
    try {
      const before = t.alerts.list.length;
      assert.equal(await t.worker.runAwaitScan(payload), 'error');
      assert.ok(t.alerts.list.slice(before).some((a) => a.kind === 'scan_timeout'));
      assert.equal((await doc(u.documentId))['scan_status'], 'error');
      assert.equal((await doc(u.documentId))['status'], 'scanning');
      const next = await t.k.q(
        `SELECT j.run_at FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier = 'documents.await_scan' AND j.payload->>'documentId' = $1 ORDER BY j.run_at DESC LIMIT 1`,
        [u.documentId],
      );
      assert.ok(
        Date.parse(String(next[0]?.['run_at'])) > Date.now() + 29 * 60_000,
        'retry is scheduled',
      );
      // A scan that arrives late still ends in the right place.
      t.setNow(undefined);
      t.scanner.release(u.key);
      assert.equal(await t.worker.runAwaitScan(payload), 'clean');
      // After 24 hours the job stops rescheduling (operations own it).
      const v = await t.uploadAs(session, patientId, PDF);
      t.setNow(() => new Date(Date.now() + 25 * 3_600_000));
      assert.equal(
        await t.worker.runAwaitScan({ documentId: v.documentId, version: 1, patientId }),
        'error',
      );
    } finally {
      t.setNow(undefined);
    }
  });

  // ===== merge during scanning (38.2 item 11) ======================================================================
  test('38.2 item 11: a document scanning at merge time is re-pointed and served after the retried scan', async () => {
    const p1 = await t.mkPatient(12);
    const p2 = await t.mkPatient(13);
    const u = await t.uploadAs(p1.session, p1.patientId, PDF);
    const merged = await t.merge(p2.patientId, p1.patientId);
    assert.equal(merged.result.status, 'completed');
    const d = await doc(u.documentId);
    assert.equal(d['patient_id'], p2.patientId, 'the document follows the patient');
    assert.equal(d['v_patient'], p2.patientId, 'and so does the version (TDR-02)');
    assert.equal(d['status'], 'scanning');
    // The job still names the merged patient: it resolves to the survivor and finishes there.
    t.scanner.release(u.key);
    assert.equal(
      await t.worker.runAwaitScan({
        documentId: u.documentId,
        version: 1,
        patientId: p1.patientId,
      }),
      'clean',
    );
    const after = await doc(u.documentId);
    assert.equal(after['status'], 'clean');
    assert.equal(after['patient_id'], p2.patientId);
    // Served: the survivor's patient gets the URL (an upload by the merged person's principal, released class); the merged ID's
    // session no longer reaches it.
    const ok = await t.pcall(p2.session, 'POST', `/api/v1/documents/${u.documentId}/download-url`);
    assert.equal(ok.status, 200);
    // The merged person's own account follows to the survivor (identity re-points its patient link), so it reaches the document too;
    // the merged ID itself is gone from every scope.
    assert.equal(
      (await t.pcall(p1.session, 'POST', `/api/v1/documents/${u.documentId}/download-url`)).status,
      200,
    );
    assert.equal(
      (await t.pcall(p1.session, 'GET', `/api/v1/patients/${p1.patientId}/documents`)).status,
      404,
    );
    // The OCR job that follows (named for the merged patient too) resolves the same way.
    assert.equal(
      await t.worker.runOcrSuggest({
        documentId: u.documentId,
        version: 1,
        patientId: p1.patientId,
      }),
      'suggested',
    );
    assert.equal((await doc(u.documentId))['suggested_classification'], 'insurance_card');
  });

  test('merge participant: documents, versions and pending requests move; holds and decided requests are kept; counts add up', async () => {
    const a = await t.mkPatient(14);
    const b = await t.mkPatient(15);
    const docId = await t.confirmedDocument(a.session, a.patientId);
    assert.equal(
      (
        await t.scall(
          t.records,
          'POST',
          `/api/v1/documents/${docId}/legal-holds`,
          holdBody('placed'),
        )
      ).status,
      201,
    );
    const refused = await t.scall(
      t.desk,
      'POST',
      `/api/v1/documents/${docId}/deletion-requests`,
      {},
    );
    assert.equal(refused.status, 409); // decided K
    assert.equal(
      (
        await t.scall(
          t.records,
          'POST',
          `/api/v1/documents/${docId}/legal-holds`,
          holdBody('released'),
        )
      ).status,
      201,
    );
    await setRetention(docId, `current_date - 1`);
    const pending = await t.scall(
      t.desk,
      'POST',
      `/api/v1/documents/${docId}/deletion-requests`,
      {},
    );
    assert.equal(pending.status, 201); // pending R
    const second = await t.cleanDocument(a.session, a.patientId); // a second document, clean
    await t.merge(b.patientId, a.patientId);
    for (const id of [docId, second]) assert.equal((await doc(id))['patient_id'], b.patientId);
    assert.equal((await doc(docId))['v_patient'], b.patientId);
    const holds = await t.k.q(
      `SELECT patient_id FROM documents.legal_hold WHERE document_id = $1`,
      [docId],
    );
    assert.deepEqual(
      holds.map((h) => h['patient_id']),
      [a.patientId, a.patientId],
      'kept rows keep the merged ID',
    );
    const reqs = await t.k.q(
      `SELECT outcome, patient_id FROM documents.deletion_request WHERE document_id = $1 ORDER BY created_at`,
      [docId],
    );
    assert.deepEqual(
      reqs.map((r) => [r['outcome'], r['patient_id']]),
      [
        ['refused_legal_hold', a.patientId],
        ['pending', b.patientId],
      ],
    );
    // A later change is a new row with the survivor's ID (SBR-16); the pending request is still decidable, now on the survivor.
    assert.equal(
      (
        await t.scall(
          t.records,
          'POST',
          `/api/v1/documents/${docId}/legal-holds`,
          holdBody('placed'),
        )
      ).status,
      201,
    );
    const last = await t.k.q(
      `SELECT patient_id, action FROM documents.legal_hold WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
      [docId],
    );
    assert.deepEqual([last[0]?.['patient_id'], last[0]?.['action']], [b.patientId, 'placed']);
    const dec = await t.scall(
      t.records,
      'POST',
      `/api/v1/deletion-requests/${String(pending.json()['id'])}/decide`,
      {},
    );
    assert.equal(dec.status, 409);
    assert.equal(code(dec), 'documents.legal_hold');
    // The merged patient can write nothing new (the guard): a new upload for the merged ID is refused.
    const nu = await t.pcall(
      a.session,
      'POST',
      `/api/v1/patients/${a.patientId}/document-uploads`,
      { contentType: 'application/pdf', sizeBytes: 10 },
    );
    assert.ok([404, 409].includes(nu.status), `merged patient upload refused, got ${nu.status}`);
  });

  // ===== the database rules no route can bypass =====================================================================
  test('database rules: who may take which step, what a version row may hold', async () => {
    const { patientId, session } = await t.mkPatient(16);
    const u = await t.uploadAs(session, patientId, PDF, { complete: false });
    const worker = {
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'org',
    } as ScopeSettings;
    const patientScope = ((): ScopeSettings => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: session.seeded.principalId,
      personId: session.seeded.personId,
      patientIds: [patientId],
    }))();
    // Awaiting upload -> clean/confirmed/deleted directly: no step of the table allows it.
    for (const next of ['clean', 'confirmed', 'deleted', 'quarantined'])
      assert.equal(
        await attempt(() =>
          t.as(scope(t.records), (tx) =>
            tx.query(`UPDATE documents.document SET status = $2 WHERE id = $1`, [
              u.documentId,
              next,
            ]),
          ),
        ),
        'PS001',
        next,
      );
    // Scanning needs the version's scan request time (the completion's own write).
    assert.equal(
      await attempt(() =>
        t.as(patientScope, (tx) =>
          tx.query(`UPDATE documents.document SET status = 'scanning' WHERE id = $1`, [
            u.documentId,
          ]),
        ),
      ),
      'PS001',
    );
    // A worker cannot make a document clean without a clean scan recorded on its version.
    assert.equal(
      await attempt(() =>
        t.wdb.withScope(worker, (tx) =>
          tx.query(`UPDATE documents.document SET status = 'clean' WHERE id = $1`, [u.documentId]),
        ),
      ),
      'PS001',
    );
    // The API role has no right to write scan columns at all; the worker may not skip the rules (object key, bucket, hash).
    assert.equal(
      await attempt(() =>
        t.as(patientScope, (tx) =>
          tx.query(
            `UPDATE documents.document_version SET scan_status = 'clean' WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
      ),
      '42501',
    );
    assert.equal(
      await attempt(() =>
        t.wdb.withScope(worker, (tx) =>
          tx.query(
            `UPDATE documents.document_version SET scan_status = 'clean', scanned_at = now(), sha256 = decode(repeat('00', 32), 'hex') WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
      ),
      'PS001',
      'a clean scan moves the file to the clean bucket under a new key',
    );
    assert.equal(
      await attempt(() =>
        t.wdb.withScope(worker, (tx) =>
          tx.query(
            `UPDATE documents.document_version SET scan_status = 'clean', scanned_at = now(), sha256 = decode(repeat('00', 32), 'hex'), bucket = 'clean' WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
      ),
      'PS001',
      'a clean file moves under a new key',
    );
    // And the table's own CHECKs hold even with every trigger off (a superuser's replica-mode write): clean needs a hash and the clean bucket.
    await t.k.sa.query('BEGIN');
    try {
      await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
      await t.k.sa.query('SAVEPOINT s1');
      assert.equal(
        await attempt(() =>
          t.k.sa.query(
            `UPDATE documents.document_version SET scan_status = 'clean' WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
        '23514',
      );
      await t.k.sa.query('ROLLBACK TO SAVEPOINT s1');
      // Keys carry no names: a key with a file name in it is refused by the table.
      assert.equal(
        await attempt(() =>
          t.k.sa.query(
            `UPDATE documents.document_version SET object_key = 'q/report-of-jane-doe.pdf' WHERE document_id = $1`,
            [u.documentId],
          ),
        ),
        '23514',
      );
    } finally {
      await t.k.sa.query('ROLLBACK');
    }
    // A confirmed document needs a clean one first; staff only; a document's identity never changes.
    assert.equal(
      await attempt(() =>
        t.as(scope(t.records), (tx) =>
          tx.query(`UPDATE documents.document SET uploaded_by = $2 WHERE id = $1`, [
            u.documentId,
            t.records.seeded.principalId,
          ]),
        ),
      ),
      '42501',
    );
    // Every table forces RLS and carries the merge guard: nothing writes for a merged or unknown patient.
    assert.equal(
      await attempt(() =>
        t.as(scope(t.records), (tx) =>
          tx.query(
            `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, current_version, uploaded_by, upload_channel, created_by)
      VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), gen_random_uuid(), 'consent', 'awaiting_upload', 1, $1, 'staff', $1)`,
            [t.records.seeded.principalId],
          ),
        ),
      ),
      'PM008',
    );
  });

  // ===== RLS ======================================================================================================
  test('RLS: own documents only, released classes for patients, no proxy, no other location, holds are staff-only', async () => {
    const a = await t.mkPatient(17);
    const b = await t.mkPatient(18);
    const id = await t.confirmedDocument(a.session, a.patientId);
    const hold = await t.scall(
      t.records,
      'POST',
      `/api/v1/documents/${id}/legal-holds`,
      holdBody('placed'),
    );
    assert.equal(hold.status, 201);
    const count = (s: ScopeSettings, table: string): Promise<number> =>
      t.as(s, async (tx) =>
        Number(
          (
            await tx.query(
              `SELECT count(*)::int AS n FROM ${table} WHERE document_id = $1`.replace(
                'document_id',
                table === 'documents.document' ? 'id' : 'document_id',
              ),
              [id],
            )
          ).rows[0]?.['n'],
        ),
      );
    const patientOf = async (
      sess: SeededSession,
      pid: string,
      proxy = false,
    ): Promise<ScopeSettings> => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: sess.seeded.principalId,
      personId: sess.seeded.personId,
      patientIds: [pid],
      ...(proxy ? { proxyPatientIds: [pid] } : {}),
    });
    const own = await patientOf(a.session, a.patientId);
    assert.equal(await count(own, 'documents.document'), 1);
    assert.equal(await count(own, 'documents.document_version'), 1);
    assert.equal(await count(own, 'documents.legal_hold'), 0, 'a patient does not see holds');
    assert.equal(
      await count(await patientOf(b.session, b.patientId), 'documents.document'),
      0,
      'another patient',
    );
    assert.equal(
      await count(await patientOf(a.session, a.patientId, true), 'documents.document'),
      0,
      'a proxy sees no documents (D-7)',
    );
    assert.equal(
      await count(await t.staffScope('front_desk', B1), 'documents.document'),
      0,
      'staff of another location',
    );
    assert.equal(await count(await t.staffScope('front_desk', A1), 'documents.document'), 1);
    assert.equal(await count(await t.staffScope('medical_records', A1), 'documents.legal_hold'), 1);
    // Released classes only, and only once clean: a staff-uploaded referral letter is not the patient's; an insurance card is.
    const staff = await t.staffScope('front_desk', A1);
    const mk = async (classification: string): Promise<string> => {
      const tk = await t.as(staff, (tx) =>
        t.svc.createUpload(tx, META, {
          patientId: a.patientId,
          contentType: 'application/pdf',
          sizeBytes: PDF.length,
          classification: classification as never,
        }),
      );
      t.store.upload(keyOfUrl(tk.uploadUrl).key, PDF, 'application/pdf');
      await t.as(staff, (tx) => t.svc.completeUpload(tx, META, tk.documentId));
      return tk.documentId;
    };
    const letter = await mk('referral_letter');
    const card = await mk('insurance_card');
    const visible = async (docId: string): Promise<number> =>
      t.as(own, async (tx) =>
        Number(
          (
            await tx.query(`SELECT count(*)::int AS n FROM documents.document WHERE id = $1`, [
              docId,
            ])
          ).rows[0]?.['n'],
        ),
      );
    assert.equal(await visible(card), 0, 'not before it is clean');
    for (const d of [letter, card]) {
      const k = String((await doc(d))['object_key']);
      t.scanner.release(k);
      assert.equal(
        await t.worker.runAwaitScan({ documentId: d, version: 1, patientId: a.patientId }),
        'clean',
      );
    }
    assert.equal(await visible(letter), 0, 'a referral letter is not released to the patient');
    assert.equal(await visible(card), 1, 'an insurance card is, once clean');
    assert.equal(
      (await t.pcall(a.session, 'POST', `/api/v1/documents/${letter}/download-url`)).status,
      404,
    );
    assert.equal(
      (await t.pcall(a.session, 'POST', `/api/v1/documents/${card}/download-url`)).status,
      200,
    );
    // Staff cannot create a document for a patient outside their scope (404 through the root lock).
    const outsider = await t.staffScope('front_desk', B1);
    await assert.rejects(
      t.as(outsider, (tx) =>
        t.svc.createUpload(tx, META, {
          patientId: a.patientId,
          contentType: 'application/pdf',
          sizeBytes: 10,
          classification: 'consent',
        }),
      ),
    );
    // attachToPatient: another module's check before it stores a reference.
    assert.equal(
      (await t.as(staff, (tx) => t.svc.attachToPatient(tx, card, a.patientId))).status,
      'clean',
    );
    await assert.rejects(
      t.as(staff, (tx) => t.svc.attachToPatient(tx, card, b.patientId)),
      DocumentNotFoundError,
    );
    const pending = await mk('consent');
    await assert.rejects(
      t.as(staff, (tx) => t.svc.attachToPatient(tx, pending, a.patientId)),
      NotAvailableError,
    );
  });

  // ===== concurrency ================================================================================================
  test('concurrency: a hold and a deletion decision racing never leave a held document deleted', async () => {
    const { patientId, session } = await t.mkPatient(19);
    const records = scope(t.records);
    let deleted = 0;
    let held = 0;
    for (let i = 0; i < 10; i++) {
      const id = await t.confirmedDocument(session, patientId);
      await setRetention(id, `current_date - 1`);
      const req = await t.as(scope(t.desk), (tx) => t.svc.requestDeletion(tx, META, id));
      assert.equal(req.outcome, 'pending');
      const [decide, place] = await Promise.allSettled([
        t.as(records, (tx) => t.svc.decideDeletion(tx, META, req.id)),
        t.as(records, (tx) =>
          t.svc.setLegalHold(tx, META, id, {
            action: 'placed',
            reason: `Hold raced with the decision ${i}`,
          }),
        ),
      ]);
      const d = await doc(id);
      const holds = Number(
        (
          await t.k.q(
            `SELECT count(*)::int AS n FROM documents.legal_hold WHERE document_id = $1`,
            [id],
          )
        )[0]?.['n'],
      );
      const outcome = (
        await t.k.q(`SELECT outcome FROM documents.deletion_request WHERE id = $1`, [req.id])
      )[0]?.['outcome'];
      if (d['status'] === 'deleted') {
        deleted++;
        assert.equal(holds, 0, 'deleted means no hold existed');
        assert.equal(outcome, 'deleted');
        assert.equal(place.status, 'rejected');
        assert.ok((place as PromiseRejectedResult).reason instanceof InvalidTransitionError);
      } else {
        held++;
        assert.equal(d['status'], 'confirmed');
        assert.equal(holds, 1);
        assert.equal(outcome, 'refused_legal_hold');
        assert.equal(place.status, 'fulfilled');
      }
      assert.ok(
        decide.status === 'fulfilled',
        `the decision itself never fails: ${decide.status === 'rejected' ? String(decide.reason) : ''}`,
      );
    }
    assert.equal(deleted + held, 10);
  });

  test('concurrency: completing one upload from many requests queues one scan job', async () => {
    const { patientId, session } = await t.mkPatient(20);
    const u = await t.uploadAs(session, patientId, PDF, { complete: false });
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.pcall(session, 'POST', `/api/v1/document-uploads/${u.documentId}/complete`, {}),
      ),
    );
    assert.ok(
      rs.every((r) => r.status === 202),
      rs.map((r) => r.status).join(),
    );
    const jobs = await t.k.q(
      `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier = 'documents.await_scan' AND j.payload->>'documentId' = $1`,
      [u.documentId],
    );
    assert.equal(Number(jobs[0]?.['n']), 1);
    assert.equal((await doc(u.documentId))['status'], 'scanning');
  });

  // ===== adapters (BE-02 interface) ===================================================================================
  test('the scan-tag adapter maps tags to verdicts, never calls an unknown tag clean, and a scanner outage is an error', async () => {
    const { adapter, client, caller } = t.tagScanner;
    const key = `q/${'ab'.repeat(16)}`;
    const ask = async (): Promise<string> => caller('quarantine', key);
    assert.equal(await ask(), 'pending', 'no tag yet');
    client.tags.set(`quarantine/${key}`, 'NO_THREATS_FOUND');
    assert.equal(await ask(), 'clean');
    client.tags.set(`quarantine/${key}`, 'THREATS_FOUND');
    assert.equal(await ask(), 'infected');
    client.tags.set(`quarantine/${key}`, 'SOMETHING_NEW');
    assert.equal(await ask(), 'error', 'an unknown value is never clean');
    client.outage = true;
    await assert.rejects(ask(), (e: unknown) => (e as { retryable?: boolean }).retryable === true);
    client.outage = false;
    await assert.rejects(
      adapter.call({
        operation: 'scan_result',
        args: { bucket: 'clean', key: '../../etc/passwd' },
        connection: {},
        credentials: {},
        idempotencyToken: 'x'.repeat(10),
        signal: new AbortController().signal,
      }),
      /bad_arguments/,
    );
    // End to end through the job: the adapter's verdict decides.
    const { patientId, session } = await t.mkPatient(21);
    const u = await t.uploadAs(session, patientId, PDF);
    t.tagScanner.client.tags.set(`quarantine/${u.key}`, 'NO_THREATS_FOUND');
    assert.equal(
      await t.worker.runAwaitScan(
        { documentId: u.documentId, version: 1, patientId },
        { scan: caller },
      ),
      'clean',
    );
  });

  test('OCR suggestion: staff-visible only, never decides; a missing, failing or late vendor is handled', async () => {
    const { patientId, session } = await t.mkPatient(22);
    const mk = async (): Promise<{ documentId: string }> => {
      const u = await t.uploadAs(session, patientId, PDF);
      t.scanner.release(u.key);
      assert.equal(
        await t.worker.runAwaitScan({ documentId: u.documentId, version: 1, patientId }),
        'clean',
      );
      return u;
    };
    const run = (documentId: string, attempt?: { number: number; max: number }): Promise<string> =>
      t.worker.runOcrSuggest({ documentId, version: 1, patientId }, attempt);
    // A suggestion is stored, shown to staff, hidden from the patient, and changes no classification.
    const a = await mk();
    t.ocr.plan = () => ({ documentType: 'referral_letter' });
    assert.equal(await run(a.documentId), 'suggested');
    assert.equal((await doc(a.documentId))['suggested_classification'], 'referral_letter');
    assert.equal((await doc(a.documentId))['classification'], 'patient_upload_other');
    assert.equal((await doc(a.documentId))['ocr_status'], 'done');
    assert.equal(await run(a.documentId), 'already_final');
    const staffView = await t.as(scope(t.records), (tx) => t.svc.get(tx, a.documentId));
    assert.equal(staffView?.suggestedClassification, 'referral_letter');
    const pv = await t.pcall(session, 'GET', `/api/v1/patients/${patientId}/documents`);
    assert.ok(
      (pv.json()['items'] as Record<string, unknown>[]).every(
        (x) => x['suggestedClassification'] === undefined,
      ),
    );
    // A suggestion outside the closed list is dropped.
    const b = await mk();
    t.ocr.plan = () => ({ documentType: 'passport_selfie' });
    assert.equal(await run(b.documentId), 'no_suggestion');
    assert.equal((await doc(b.documentId))['suggested_classification'], null);
    // An unavailable vendor is retried by the queue; at the last attempt the suggestion is `failed` and operations know.
    const c = await mk();
    t.ocr.plan = () => t.ocrError(true, 503) as never;
    await assert.rejects(run(c.documentId, { number: 1, max: 8 }));
    assert.equal((await doc(c.documentId))['ocr_status'], 'pending');
    const before = t.alerts.list.length;
    assert.equal(await run(c.documentId, { number: 8, max: 8 }), 'failed');
    assert.equal((await doc(c.documentId))['ocr_status'], 'failed');
    assert.ok(t.alerts.list.slice(before).some((x) => x.kind === 'ocr_failed'));
    // A vendor that refuses the request is final at once.
    const d = await mk();
    t.ocr.plan = () => t.ocrError(false, 400) as never;
    assert.equal(await run(d.documentId), 'failed');
    // Confirmed before the suggestion arrives: skipped, nothing written.
    const e = await mk();
    const v = Number((await doc(e.documentId))['row_version']);
    assert.equal(
      (
        await t.scall(
          t.records,
          'POST',
          `/api/v1/documents/${e.documentId}/confirm`,
          {},
          { 'if-match': `W/"${v}"` },
        )
      ).status,
      200,
    );
    t.ocr.plan = () => ({ documentType: 'consent' });
    assert.equal(await run(e.documentId), 'skipped');
    assert.equal((await doc(e.documentId))['suggested_classification'], null);
    assert.equal(
      await attempt(() =>
        t.as(scope(t.records), (tx) =>
          tx.query(
            `UPDATE documents.document SET suggested_classification = 'consent' WHERE id = $1`,
            [e.documentId],
          ),
        ),
      ),
      '42501',
      'not even a staff write',
    );
    // No OCR connection enabled (C-10 not provisioned): skipped, the document is still usable.
    await t.k.sa.query(`UPDATE integration_core.connection SET enabled = false WHERE kind = 'ocr'`);
    try {
      const f = await mk();
      assert.equal(await run(f.documentId), 'skipped');
      assert.equal((await doc(f.documentId))['ocr_status'], 'skipped');
    } finally {
      await t.k.sa.query(
        `UPDATE integration_core.connection SET enabled = true WHERE kind = 'ocr'`,
      );
    }
  });

  // ===== export part ================================================================================================
  test('the export part lists metadata only: no object key, no URL; holds and requests included', async () => {
    const { patientId, session } = await t.mkPatient(23);
    const id = await t.confirmedDocument(session, patientId);
    assert.equal(
      (await t.scall(t.records, 'POST', `/api/v1/documents/${id}/legal-holds`, holdBody('placed')))
        .status,
      201,
    );
    assert.equal(
      (await t.scall(t.desk, 'POST', `/api/v1/documents/${id}/deletion-requests`, {})).status,
      409,
    );
    const part = (await t.wdb.withScope(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [patientId],
      } as ScopeSettings,
      (tx) => documentsExportContributor.exportPart(tx, [patientId], crypto.randomUUID()),
    )) as Record<string, Record<string, unknown>[]>;
    assert.equal(part['documents']?.length, 1);
    assert.equal(part['versions']?.[0]?.['retrievable'], true);
    assert.equal(part['legalHolds']?.length, 1);
    assert.equal(part['deletionRequests']?.length, 1);
    const text = JSON.stringify(part);
    assert.ok(!/object_?[kK]ey|"q\/|"c\/|https?:/.test(text), 'no key and no URL in the package');
  });

  // ===== no PHI anywhere it must not be ===============================================================================
  test("no PHI in object keys, URLs, audit rows or logs; a hold's reason lives only in its own row", async () => {
    const keys = await t.k.q(`SELECT object_key FROM documents.document_version`);
    assert.ok(keys.length > 10);
    for (const k of keys) assert.match(String(k['object_key']), /^[qc]\/[0-9a-f]{32}$/);
    const all = [...t.logs, ...[...t.store.objects.keys()]].join('\n');
    assert.ok(
      !/Given\d|Family\d|person\d+@example|\+1212555/.test(all),
      'no name, e-mail or phone in logs or keys',
    );
    assert.ok(!all.includes(CANARY), 'no hold reason in logs');
    const audit = await t.k.q(
      `SELECT count(*)::int AS n FROM audit.event WHERE resource_type LIKE 'documents.%' AND (change::text LIKE $1 OR coalesce(reason, '') LIKE $1)`,
      [`%CANARY%`],
    );
    assert.equal(Number(audit[0]?.['n']), 0, 'no hold reason in the audit trail');
    const inHolds = await t.k.q(
      `SELECT count(*)::int AS n FROM documents.legal_hold WHERE reason LIKE $1`,
      [`%${CANARY}%`],
    );
    assert.ok(Number(inHolds[0]?.['n']) > 0, 'but it is in its own row');
    // A URL never carries a patient or document ID, a name or a date of birth: only a random key, an expiry and a signature.
    const { patientId, session } = await t.mkPatient(24);
    const u = await t.uploadAs(session, patientId, PDF);
    const url = String(u.ticket['uploadUrl']);
    assert.ok(
      !url.includes(u.documentId) &&
        !url.includes(patientId) &&
        !/Given|Family|1980-?05-?17/.test(url), // the date of birth, not a bare year: random hex contains "1980" in about 1 URL in 700
    );
  });

  // ===== photoUrl (banner photo, PRD 8.3, BR-34) ==================================================================
  test('photoUrl: a clean photo gives a 60-second URL for its own object; none, unclean and invisible give null', async () => {
    const { patientId, session } = await t.mkPatient(31);
    const other = await t.mkPatient(32);
    const documentId = await t.cleanDocument(session, patientId);
    const staff = scope(t.desk);
    const ownScope: ScopeSettings = {
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: session.seeded.principalId,
      personId: session.seeded.personId,
      patientIds: [patientId],
    };
    const otherScope: ScopeSettings = {
      ...ownScope,
      principalId: other.session.seeded.principalId,
      personId: other.session.seeded.personId,
      patientIds: [other.patientId],
    };
    // Present: staff and the owner both get a URL for the clean object, valid for 60 seconds and no more.
    const url = await t.as(staff, (tx) => t.svc.photoUrl(tx, documentId, patientId));
    assert.ok(url !== null);
    const { key } = keyOfUrl(url);
    assert.equal(key, String((await doc(documentId))['object_key']));
    assert.match(
      url,
      /^https:\/\/objects\.invalid\/clean\/c\/[0-9a-f]{32}\?exp=\d+&sig=[0-9a-f]{64}$/,
    );
    const ct = { contentType: 'application/pdf' };
    const at = new Date();
    assert.equal(t.presigner.verify('GET', url, ct, at), true);
    assert.equal(
      t.presigner.verify('GET', url, ct, new Date(at.getTime() + 61_000)),
      false,
      'the URL lives 60 seconds',
    );
    assert.ok((await t.as(ownScope, (tx) => t.svc.photoUrl(tx, documentId, patientId))) !== null);
    // Patient scope: another patient's session cannot see the document, so there is no photo (and no error).
    assert.equal(await t.as(otherScope, (tx) => t.svc.photoUrl(tx, documentId, patientId)), null);
    // Patient binding (F-1): a staff caller who can see both patients still gets no photo for another patient's document.
    assert.equal(await t.as(staff, (tx) => t.svc.photoUrl(tx, documentId, other.patientId)), null);
    // None: an ID that is no document.
    assert.equal(
      await t.as(staff, (tx) =>
        t.svc.photoUrl(tx, '00000000-0000-4000-8000-000000000000', patientId),
      ),
      null,
    );
    // Not clean: awaiting scan, and quarantined as infected.
    const pending = await t.uploadAs(session, patientId, PDF);
    assert.equal(
      await t.as(staff, (tx) => t.svc.photoUrl(tx, pending.documentId, patientId)),
      null,
    );
    const bad = await t.uploadAs(session, patientId, EICAR_PDF);
    t.scanner.release(bad.key);
    assert.equal(
      await t.worker.runAwaitScan({ documentId: bad.documentId, version: 1, patientId }),
      'quarantined',
    );
    assert.equal(await t.as(staff, (tx) => t.svc.photoUrl(tx, bad.documentId, patientId)), null);
    // A banner read is not a download: photoUrl writes no `download` audit event of its own.
    const n = Number(
      (
        await t.k.q(
          `SELECT count(*)::int AS n FROM audit.event WHERE action = 'download' AND resource_type = 'documents.document' AND resource_id = $1`,
          [documentId],
        )
      )[0]?.['n'],
    );
    assert.equal(n, 0);
  });
});
