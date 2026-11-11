// Real-database tests for BE-20 (privacy) on PostgreSQL 17 with the real roles, migrations 1900-1902, the real Nest application and
// identity guard, the real audit service and queue, and the worker's real privacy jobs over an in-memory package store:
//   TC-PR-02 (export request, identity check, compliance sees it, chunked assembly, each part audited, delivery through the portal),
//   TC-PR-03 (deletion request recorded and routed, nothing deleted before approval; the execution is deletion.dbtest.ts), TC-PR-04 (another patient's export is refused),
//   TC-PR-05 (processing before the identity check is refused; refusal with reason), the contributor coverage rule, the merge
//   participant, the incident register, RLS and the compliance slice, and the rules no route can bypass.
// TC-PR-01 (notification preferences) is the patient module's and TC-NT-08's. docs/TEST-CASES.md defines TC-PR-01..05 only; there is no
// TC-PR-06..08 to run (README, limitation L1).
// The package store is in memory: it proves OUR side of the interface, NOT encryption at rest or any property of a real object store (C-01).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/privacy/privacy.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ParticipantRegistries } from '@ehr/kernel';
import type { ExportContributor, ScopeSettings, Tx } from '@ehr/kernel';
import { PRIVACY_JOBS } from './jobs.js';
import { PRIVACY_CONFLICT_RULES, PRIVACY_MERGE_TABLES } from './merge.js';
import { REGISTERED_EXPORT_MODULES } from '../../register-participants.js';
import { ORG, buildRegistries, setupPrivacy, uuidv7 } from './testkit.js';
import type { PatientKit, PrivacyKit, SeededSession } from './testkit.js';

const CANARY = 'CANARY-PRIVACY-DETAIL-7c1e';
const MERGE_REASON = 'Same person registered twice';
void MERGE_REASON;

describe('privacy (BE-20) on PostgreSQL 17', () => {
  let t: PrivacyKit;
  let seq = 100;
  before(async () => {
    t = await setupPrivacy('privacy');
  });
  after(async () => {
    await t.close();
  });

  const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
  const patScope = (p: PatientKit): ScopeSettings => ({
    audience: 'patient',
    realm: 'patient_pool',
    orgId: ORG,
    principalId: p.session.seeded.principalId,
    personId: p.session.seeded.personId,
    patientIds: [p.patientId],
  });
  const adminScope = (s: SeededSession, scopes: string[]): ScopeSettings => ({
    audience: 'staff',
    realm: 'admin_pool',
    orgId: ORG,
    principalId: s.seeded.principalId,
    personId: s.seeded.personId,
    phiAccess: 'limited',
    complianceScopes: scopes,
  });
  const count = async (tx: Tx, sql: string, params: unknown[] = []): Promise<number> =>
    Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);
  const mk = async (): Promise<PatientKit> => t.mkPatient(++seq);
  const req = async (
    p: PatientKit,
    kind = 'export',
    detail?: string,
  ): Promise<Record<string, unknown>> => {
    const r = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', {
      kind,
      ...(detail === undefined ? {} : { detail }),
    });
    assert.equal(r.status, 201, r.body);
    return r.json();
  };
  const row = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> =>
    (await t.k.q(sql, params))[0] as Record<string, unknown>;
  const jobs = (name: string, key: string, value: string): Promise<number> =>
    t.k
      .q<{ n: number }>(
        `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier = $1 AND j.payload->>$2 = $3`,
        [name, key, value],
      )
      .then((r) => r[0]?.n ?? 0);
  /** A complete cycle: request, verify, approve, assemble. Returns the finished pieces. */
  const finished = async (
    p: PatientKit,
  ): Promise<{ requestId: string; packageId: string; key: string }> => {
    const a = await t.approvedExport(p);
    const out = await t.assemble(a.packageId);
    assert.equal(out.status, 'ready', JSON.stringify(out));
    const pk = await row(`SELECT object_key FROM privacy.export_package WHERE id = $1`, [
      a.packageId,
    ]);
    return { ...a, key: String(pk['object_key']) };
  };
  const registries = buildRegistries;

  test('job types: the API and worker sides declare the same list; every job that carries patient IDs declares on_merged', () => {
    assert.deepEqual(
      PRIVACY_JOBS.map((j) => j.name),
      [
        'privacy.assemble_export',
        'privacy.check_legal_holds',
        'privacy.execute_deletion',
        'privacy.send_deletion_statement',
        'privacy.expire_packages',
        'privacy.retention_purge',
      ],
    );
    for (const j of PRIVACY_JOBS)
      if (j.carriesPatientIds) assert.equal(j.onMerged, 'resolve', j.name);
    assert.deepEqual(PRIVACY_MERGE_TABLES, ['privacy.request', 'privacy.export_package']);
    assert.equal(PRIVACY_CONFLICT_RULES.length, 2);
  });

  // ---- TC-PR-02 -----------------------------------------------------------------------------------------------------------
  test('TC-PR-02: a patient requests an export; compliance sees it, verifies identity and approves; it is assembled and delivered through the portal', async () => {
    const p = await mk();
    const created = await req(p, 'export', `please send everything ${CANARY}`);
    const requestId = String(created['id']);
    assert.equal(created['status'], 'received');
    assert.equal(created['kind'], 'export');
    assert.equal(created['channel'], 'portal');
    assert.equal(created['package'], null);

    // Compliance sees the request (metadata and the requester's own words) in its list.
    const list = await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests');
    assert.equal(list.status, 200, list.body);
    const seen = (list.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === requestId,
    );
    assert.ok(seen !== undefined, 'compliance sees the request');
    assert.equal(seen['status'], 'received');
    assert.equal(seen['patientId'], p.patientId);
    // The patient sees it in their own list.
    const mine = await t.pcall(p.session, 'GET', '/api/v1/privacy-requests');
    assert.ok(
      (mine.json()['items'] as Record<string, unknown>[]).some((x) => x['id'] === requestId),
    );

    // TC-PR-05 part: processing before the identity check is complete is refused.
    const early = await t.decide(requestId, 'approve');
    assert.equal(early.status, 409);
    assert.equal(code(early), 'privacy.invalid_transition');
    assert.equal(
      (await row(`SELECT status FROM privacy.request WHERE id = $1`, [requestId]))['status'],
      'received',
    );

    const v = await t.verify(requestId);
    assert.equal(v.status, 200, v.body);
    assert.equal(v.json()['status'], 'identity_verified');
    assert.equal(v.json()['verificationMethod'], 'in person with photo id');
    assert.equal((await t.verify(requestId)).status, 409, 'identity is verified once');

    const d = await t.decide(requestId, 'approve');
    assert.equal(d.status, 200, d.body);
    assert.equal(d.json()['status'], 'in_progress');
    const pkg = d.json()['package'] as Record<string, unknown>;
    assert.equal(pkg['status'], 'assembling');
    const packageId = String(pkg['id']);
    // The assembly job was queued in the same transaction, IDs only.
    assert.equal(await jobs('privacy.assemble_export', 'packageId', packageId), 1);

    // While it assembles the patient has nothing to download.
    const early2 = await t.pcall(
      p.session,
      'POST',
      `/api/v1/privacy-requests/${requestId}/export/download-url`,
    );
    assert.equal(early2.status, 409);
    assert.equal(code(early2), 'privacy.export_not_ready');
    const own = await t.pcall(p.session, 'GET', `/api/v1/privacy-requests/${requestId}`);
    assert.equal(
      own.json()['package'],
      null,
      'a package that is not ready is not shown to the patient',
    );

    const out = await t.assemble(packageId);
    assert.equal(out.status, 'ready', JSON.stringify(out));
    const st = await row(
      `SELECT p.status AS pstatus, p.object_key, p.size_bytes, p.part_counts, p.expires_at, r.status AS rstatus
         FROM privacy.export_package p JOIN privacy.request r ON r.id = p.request_id WHERE p.id = $1`,
      [packageId],
    );
    assert.equal(st['pstatus'], 'ready');
    assert.equal(st['rstatus'], 'fulfilled');
    assert.match(String(st['object_key']), /^p\/[0-9a-f]{32}$/);
    assert.ok(t.store.has(String(st['object_key'])));

    // The package: a manifest and one part per contributor, plus the accounting of disclosures.
    const bundle = t.store.read(String(st['object_key']));
    const expected = [
      ...t.regs.exportContributors().map((c) => c.module),
      'patient',
      'privacy',
    ].sort();
    assert.deepEqual(Object.keys(bundle.parts).sort(), expected);
    // INT03-F04: the package holds a part from every contributor the shared registration registers (none is silently absent).
    assert.deepEqual(
      t.regs
        .exportContributors()
        .map((c) => c.module)
        .sort(),
      [...REGISTERED_EXPORT_MODULES].sort(),
    );
    for (const m of REGISTERED_EXPORT_MODULES)
      assert.ok(bundle.parts[m] !== undefined, `the package has a part from ${m}`);
    assert.deepEqual(
      Object.keys(bundle.manifest['parts'] as object).sort(),
      [...expected, 'audit'].sort(),
    );
    assert.deepEqual(bundle.manifest['patientIds'], [p.patientId]);
    const privacyPart = bundle.parts['privacy'] as { requests: Record<string, unknown>[] };
    assert.equal(privacyPart.requests.length, 1);
    assert.ok(
      String(privacyPart.requests[0]?.['detail']).includes(CANARY),
      "the patient's own words are theirs to take",
    );
    const identityPart = JSON.stringify(bundle.parts['identity']);
    assert.ok(
      identityPart.includes(p.patientId),
      'the identity part carries the portal account link',
    );
    // The accounting of disclosures includes what happened to this patient's record, including the request itself.
    assert.ok(
      bundle.accountingOfDisclosures.events.some(
        (e) => e['resourceType'] === 'privacy.request' && e['resourceId'] === requestId,
      ),
      'accounting of disclosures lists the request',
    );
    assert.ok(
      bundle.accountingOfDisclosures.events.some((e) => e['action'] === 'export'),
      'and the parts exported so far',
    );

    // Each part was audited (one `export` event per part, the disclosures included), by the job, naming IDs only.
    const parts = Object.keys(bundle.manifest['parts'] as object).length;
    assert.equal(
      Number(
        (
          await row(
            `SELECT count(*)::int AS n FROM audit.event WHERE resource_type = 'privacy.export_package' AND resource_id = $1 AND action = 'export'`,
            [packageId],
          )
        )['n'],
      ),
      parts,
    );
    // Progress is visible to compliance as counts, not content.
    const view = await t.scall(
      t.compliance,
      'GET',
      '/api/v1/admin/privacy-requests?status=fulfilled',
    );
    const item = (view.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === requestId,
    );
    assert.ok(item !== undefined);
    const meta = item['package'] as Record<string, unknown>;
    assert.equal(meta['status'], 'ready');
    assert.deepEqual(
      Object.keys(meta['partCounts'] as object).sort(),
      [...expected, 'audit'].sort(),
    );
    assert.ok(
      !view.body.includes('objectKey') && !view.body.includes('"p/'),
      'no object key for compliance',
    );
    assert.ok(!view.body.includes('given_name'), 'no export content for compliance (6.7)');

    // Delivery: a short-lived URL, audited, no PHI in it; the first download releases the package.
    const dl = await t.pcall(
      p.session,
      'POST',
      `/api/v1/privacy-requests/${requestId}/export/download-url`,
    );
    assert.equal(dl.status, 200, dl.body);
    const url = String(dl.json()['url']);
    assert.ok(
      url.includes(String(st['object_key'])) && !url.includes(p.patientId) && !url.includes(CANARY),
    );
    const ttl = new Date(String(dl.json()['expiresAt'])).getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= 61_000, `60-second URL, got ${ttl} ms`);
    assert.equal(
      (await row(`SELECT status FROM privacy.export_package WHERE id = $1`, [packageId]))['status'],
      'released',
    );
    assert.equal(
      (
        await t.pcall(
          p.session,
          'POST',
          `/api/v1/privacy-requests/${requestId}/export/download-url`,
        )
      ).status,
      200,
    );
    assert.equal(
      Number(
        (
          await row(
            `SELECT count(*)::int AS n FROM audit.event WHERE resource_id = $1 AND action = 'export' AND reason = 'patient_download'`,
            [packageId],
          )
        )['n'],
      ),
      2,
    );

    // Compliance has no download route (6.7), and the notice carries no PHI: the event payload is IDs.
    const adminDl = await t.scall(
      t.compliance,
      'POST',
      `/api/v1/privacy-requests/${requestId}/export/download-url`,
    );
    assert.equal(adminDl.status, 403);

    // No canary anywhere it must not be: audit rows, queue payloads, the URL, the key.
    assert.equal(
      Number(
        (
          await row(
            `SELECT count(*)::int AS n FROM audit.event WHERE change::text LIKE '%CANARY%' OR reason LIKE '%CANARY%'`,
          )
        )['n'],
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await row(
            `SELECT count(*)::int AS n FROM queue._private_jobs WHERE payload::text LIKE '%CANARY%'`,
          )
        )['n'],
      ),
      0,
    );
  });

  test('access requests are assembled the same way as exports', async () => {
    const p = await mk();
    const a = await t.approvedExport(p, 'access');
    assert.equal((await t.assemble(a.packageId)).status, 'ready');
  });

  // ---- TC-PR-03 (the request half; the execution is in deletion.dbtest.ts) ---------------------------------------------------
  test('TC-PR-03: a deletion request is recorded and routed to compliance; nothing is deleted before approval; the database refuses a shortcut', async () => {
    const p = await mk();
    const before = {
      patients: Number((await row(`SELECT count(*)::int AS n FROM patient.patient`))['n']),
      requests: Number((await row(`SELECT count(*)::int AS n FROM privacy.request`))['n']),
    };
    const created = await req(p, 'deletion', 'please delete my account');
    const requestId = String(created['id']);
    assert.equal(
      created['status'],
      'received',
      'D-8 is decided (owner ruling C): a request like any other',
    );
    assert.equal(created['deletion'], null);

    // Compliance sees it.
    const list = await t.scall(
      t.compliance,
      'GET',
      '/api/v1/admin/privacy-requests?status=received',
    );
    assert.ok(
      (list.json()['items'] as Record<string, unknown>[]).some((x) => x['id'] === requestId),
    );

    // Not approvable before the identity check; then the identity is confirmed and the request is identity_verified.
    assert.equal(code(await t.decide(requestId, 'approve')), 'privacy.invalid_transition');
    const v = await t.verify(requestId);
    assert.equal(v.status, 200, v.body);
    assert.equal(v.json()['status'], 'identity_verified');
    assert.ok(v.json()['verifiedAt'] !== null);

    // Nothing was deleted, started or queued yet: no execution job, no deletion record; the patient and their record are all still there.
    assert.equal(await jobs('privacy.execute_deletion', 'requestId', requestId), 0);
    assert.equal(
      Number(
        (
          await row(
            `SELECT count(*)::int AS n FROM privacy.deletion_record WHERE request_id = $1`,
            [requestId],
          )
        )['n'],
      ),
      0,
    );
    assert.equal(
      Number((await row(`SELECT count(*)::int AS n FROM patient.patient`))['n']),
      before.patients,
    );
    assert.equal(
      Number((await row(`SELECT count(*)::int AS n FROM privacy.request`))['n']),
      before.requests + 1,
    );
    assert.equal(
      (await row(`SELECT status FROM patient.patient WHERE id = $1`, [p.patientId]))['status'],
      'active',
    );

    // No shortcut: compliance cannot complete a deletion request (only the worker, after its deletion record exists) and "fulfil"/"retry"
    // are not steps of an unapproved request.
    assert.equal(code(await t.decide(requestId, 'fulfil')), 'privacy.invalid_transition');
    assert.equal(code(await t.decide(requestId, 'retry')), 'privacy.invalid_transition');
    await assert.rejects(
      t.as(adminScope(t.compliance, ['privacy_requests']), (tx) =>
        tx.query(`UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid`, [
          requestId,
        ]),
      ),
      /illegal request step|PS001/i,
    );

    // Compliance may refuse it, with a reason.
    assert.equal((await t.decide(requestId, 'refuse', 'short')).status, 422);
    const rf = await t.decide(requestId, 'refuse', 'Requester withdrew the request by phone.');
    assert.equal(rf.status, 200, rf.body);
    assert.equal(rf.json()['status'], 'refused');
  });

  test('the legal-hold check on a deletion request: the system counts documents under a hold, and compliance sees it', async () => {
    const p = await mk();
    const requestId = String((await req(p, 'deletion'))['id']);
    assert.equal(
      await jobs('privacy.check_legal_holds', 'requestId', requestId),
      1,
      'queued with the request',
    );
    assert.equal(await t.w.checkHolds(requestId), 'checked');
    let item = (
      (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests?status=received')).json()[
        'items'
      ] as Record<string, unknown>[]
    ).find((x) => x['id'] === requestId) as Record<string, unknown>;
    assert.equal((item['legalHold'] as Record<string, unknown>)['documents'], 0);

    // A document of this patient under a legal hold (seeded below the triggers: the documents module's own tests prove its rules).
    const docId = uuidv7();
    await t.k.sa.query('BEGIN');
    try {
      await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
      await t.k.sa.query(
        `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, uploaded_by, upload_channel, created_by)
         VALUES ($1, $2, $3, 'patient_upload_other', 'awaiting_upload', $4, 'patient', $4)`,
        [docId, ORG, p.patientId, p.session.seeded.principalId],
      );
      await t.k.sa.query(
        `INSERT INTO documents.document_version (document_id, version, organisation_id, patient_id, object_key, bucket, size_bytes, content_type, declared_content_type, created_by)
         VALUES ($1, 1, $2, $3, $4, 'quarantine', 10, 'application/pdf', 'application/pdf', $5)`,
        [docId, ORG, p.patientId, `q/${'a'.repeat(32)}`, p.session.seeded.principalId],
      );
      await t.k.sa.query(
        `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by)
         VALUES ($1, $2, $3, $4, 'placed', 'Synthetic hold for the test', $5, $6)`,
        [
          uuidv7(),
          ORG,
          docId,
          p.patientId,
          t.compliance.seeded.personId,
          t.compliance.seeded.principalId,
        ],
      );
      await t.k.sa.query('COMMIT');
    } catch (e) {
      await t.k.sa.query('ROLLBACK');
      throw e;
    }
    assert.equal(await t.w.checkHolds(requestId), 'checked');
    item = (
      (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests?status=received')).json()[
        'items'
      ] as Record<string, unknown>[]
    ).find((x) => x['id'] === requestId) as Record<string, unknown>;
    assert.equal((item['legalHold'] as Record<string, unknown>)['documents'], 1);
    assert.equal(
      item['status'],
      'received',
      'a hold decides nothing: the execution job applies it',
    );
    // The document is untouched.
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [docId]))['status'],
      'awaiting_upload',
    );
    // A refused request is final: the check leaves it alone.
    assert.equal(
      (await t.decide(requestId, 'refuse', 'Refused for the test of finality.')).status,
      200,
    );
    assert.equal(await t.w.checkHolds(requestId), 'final');
  });

  // ---- TC-PR-04 -----------------------------------------------------------------------------------------------------------
  test("TC-PR-04: a patient cannot see or download another patient's export; the database says the same", async () => {
    const p1 = await mk();
    const p2 = await mk();
    const done = await finished(p1);
    assert.equal(
      (
        await t.pcall(
          p1.session,
          'POST',
          `/api/v1/privacy-requests/${done.requestId}/export/download-url`,
        )
      ).status,
      200,
    );

    const g = await t.pcall(p2.session, 'GET', `/api/v1/privacy-requests/${done.requestId}`);
    assert.equal(g.status, 404);
    assert.equal(code(g), 'kernel.not_found');
    const dl = await t.pcall(
      p2.session,
      'POST',
      `/api/v1/privacy-requests/${done.requestId}/export/download-url`,
    );
    assert.equal(dl.status, 404);
    assert.ok(
      !dl.body.includes(done.key) && !dl.body.includes('objects.invalid'),
      'no URL, no key',
    );
    const list = await t.pcall(p2.session, 'GET', '/api/v1/privacy-requests');
    assert.ok(
      !(list.json()['items'] as Record<string, unknown>[]).some((x) => x['id'] === done.requestId),
    );

    await t.as(patScope(p2), async (tx) => {
      assert.equal(
        await count(tx, `SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [
          done.requestId,
        ]),
        0,
      );
      assert.equal(
        await count(tx, `SELECT count(*)::int AS n FROM privacy.export_package WHERE id = $1`, [
          done.packageId,
        ]),
        0,
      );
    });
    // Not even by writing: p2 cannot create a request for p1 or release p1's package.
    await assert.rejects(
      t.as(patScope(p2), (tx) =>
        tx.query(
          `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, status, due_at, created_by)
           VALUES ($1, $2, $3, 'export', $4, 'portal', 'received', now() + interval '30 days', $4)`,
          [uuidv7(), ORG, p1.patientId, p2.session.seeded.principalId],
        ),
      ),
      /row-level security|42501/i,
    );
    await t.as(patScope(p2), async (tx) => {
      const u = await tx.query(
        `UPDATE privacy.export_package SET status = 'released', released_at = now() WHERE id = $1`,
        [done.packageId],
      );
      assert.equal(u.rowCount, 0);
    });
  });

  // ---- TC-PR-05 -----------------------------------------------------------------------------------------------------------
  test('TC-PR-05: processing an export before the identity check is refused; compliance records the refusal with a reason', async () => {
    const p = await mk();
    const requestId = String((await req(p, 'export'))['id']);
    const open = await t.decide(requestId, 'approve');
    assert.equal(open.status, 409);
    assert.equal(code(open), 'privacy.invalid_transition');
    assert.equal(
      Number(
        (
          await row(`SELECT count(*)::int AS n FROM privacy.export_package WHERE request_id = $1`, [
            requestId,
          ])
        )['n'],
      ),
      0,
    );
    // A reason of at least ten characters.
    for (const bad of [undefined, '', 'too short', 'x'.repeat(2001)])
      assert.equal((await t.decide(requestId, 'refuse', bad)).status, 422, String(bad));
    const rf = await t.decide(
      requestId,
      'refuse',
      'Identity could not be confirmed with the details given.',
    );
    assert.equal(rf.status, 200, rf.body);
    assert.equal(rf.json()['status'], 'refused');
    assert.equal(
      rf.json()['decisionReason'],
      'Identity could not be confirmed with the details given.',
    );
    assert.ok(rf.json()['decidedAt'] !== null);
    // The patient sees the refusal and its reason.
    const mine = await t.pcall(p.session, 'GET', `/api/v1/privacy-requests/${requestId}`);
    assert.equal(mine.json()['status'], 'refused');
    assert.equal(
      mine.json()['decisionReason'],
      'Identity could not be confirmed with the details given.',
    );
    // Final.
    assert.equal(
      (await t.decide(requestId, 'refuse', 'Trying to refuse it a second time.')).status,
      409,
    );
    assert.equal((await t.verify(requestId)).status, 409);
    const decidedBy = await row(`SELECT decided_by_person_id FROM privacy.request WHERE id = $1`, [
      requestId,
    ]);
    assert.equal(decidedBy['decided_by_person_id'], t.compliance.seeded.personId);
  });

  // ---- contributors -------------------------------------------------------------------------------------------------------
  test('coverage: a module that holds patient data and has no contributor FAILS the job before anything is read', async () => {
    const p = await mk();
    const a = await t.approvedExport(p);
    const before = t.store.objects.size;
    let read = 0;
    const spy: ExportContributor = {
      module: 'documents',
      exportPart: () => {
        read++;
        return Promise.resolve({});
      },
    };
    const partial = registries(['documents', 'notifications']); // notifications is missing; documents is the spy
    partial.registerExportContributor(spy);
    const failures: string[] = [];
    const out = await t.assemble(a.packageId, {
      registries: partial,
      onFailure: (i) => void failures.push(i.code),
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.status === 'failed' ? out.code : '', 'privacy.contributor_missing');
    assert.deepEqual(failures, ['privacy.contributor_missing']);
    assert.equal(read, 0, 'nothing was read');
    assert.equal(t.store.objects.size, before, 'nothing was written to the store');
    const pk = await row(
      `SELECT status, failure_code, object_key FROM privacy.export_package WHERE id = $1`,
      [a.packageId],
    );
    assert.equal(pk['status'], 'failed');
    assert.equal(pk['failure_code'], 'privacy.contributor_missing');
    assert.equal(pk['object_key'], null);
    assert.equal(
      (await row(`SELECT status FROM privacy.request WHERE id = $1`, [a.requestId]))['status'],
      'in_progress',
    );
    // The failure is visible to compliance, by code only, and never names the module in a log or row.
    const v = await t.scall(
      t.compliance,
      'GET',
      '/api/v1/admin/privacy-requests?status=in_progress',
    );
    const item = (v.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === a.requestId,
    ) as Record<string, unknown>;
    assert.equal(
      (item['package'] as Record<string, unknown>)['failureCode'],
      'privacy.contributor_missing',
    );
    // The patient is told nothing is ready.
    assert.equal(
      code(
        await t.pcall(
          p.session,
          'POST',
          `/api/v1/privacy-requests/${a.requestId}/export/download-url`,
        ),
      ),
      'privacy.export_not_ready',
    );
    // A failed package is final; a second run does nothing; a retry makes a new package, which now succeeds with every contributor.
    assert.equal((await t.assemble(a.packageId)).status, 'skipped');
    const retry = await t.decide(a.requestId, 'retry');
    assert.equal(retry.status, 200, retry.body);
    const next = (retry.json()['package'] as Record<string, unknown>)['id'] as string;
    assert.notEqual(next, a.packageId);
    assert.equal((await t.assemble(next)).status, 'ready');
    // Retry is only for a failed package.
    assert.equal((await t.decide(a.requestId, 'retry')).status, 409);
  });

  test('coverage: a module whose contributor is not registered (it holds a patient_id table) fails until it is registered, then its part is in the package (INT03-F04 negative control)', async () => {
    const p = await mk();
    const a = await t.approvedExport(p);
    // The shared database holds telehealth.session; a registry without telehealth must fail the assembly, not skip the part.
    const out = await t.assemble(a.packageId, { registries: registries(['telehealth']) });
    assert.equal(out.status, 'failed');
    assert.equal(out.status === 'failed' ? out.code : '', 'privacy.contributor_missing');

    const retry = await t.decide(a.requestId, 'retry');
    const pkg = (retry.json()['package'] as Record<string, unknown>)['id'] as string;
    const done = await t.assemble(pkg, { registries: registries() });
    assert.equal(done.status, 'ready', JSON.stringify(done));
    const key = String(
      (await row(`SELECT object_key FROM privacy.export_package WHERE id = $1`, [pkg]))[
        'object_key'
      ],
    );
    const bundle = t.store.read(key);
    for (const m of REGISTERED_EXPORT_MODULES) assert.ok(m in bundle.parts, `a part for ${m}`);
    assert.ok('patient' in bundle.parts && 'privacy' in bundle.parts);
  });

  test('chunks: each contributor runs in its own short transaction, and progress is committed between them', async () => {
    const p = await mk();
    const a = await t.approvedExport(p);
    const real = t.regs.exportContributors();
    const reg = new ParticipantRegistries();
    const txids: Record<string, string> = {};
    const seenCounts: Record<string, string[]> = {};
    for (const c of real) {
      reg.registerExportContributor({
        module: c.module,
        async exportPart(tx, ids, requestId) {
          txids[c.module] = String((await tx.query(`SELECT txid_current() AS x`)).rows[0]?.['x']);
          // What earlier chunks committed is already visible to anyone else.
          const pc = await row(`SELECT part_counts FROM privacy.export_package WHERE id = $1`, [
            a.packageId,
          ]);
          seenCounts[c.module] = Object.keys(pc['part_counts'] as object);
          return c.exportPart(tx, ids, requestId);
        },
      });
    }
    const out = await t.assemble(a.packageId, { registries: reg });
    assert.equal(out.status, 'ready', JSON.stringify(out));
    const ids = Object.values(txids);
    assert.equal(ids.length, real.length);
    assert.equal(new Set(ids).size, ids.length, 'a transaction per contributor');
    const order = real.map((c) => c.module);
    assert.deepEqual(seenCounts[order[0] as string], [], 'the first chunk sees no progress');
    assert.ok(
      (seenCounts[order[1] as string] ?? []).includes(order[0] as string),
      'the second sees the first committed',
    );
    assert.ok(Object.keys(seenCounts).length === order.length);
  });

  test('failure handling: a transient error is retried, a permanent one (or the last attempt) marks the package failed, a store outage leaves nothing behind', async () => {
    const p = await mk();
    const a = await t.approvedExport(p);
    let calls = 0;
    const flaky = registries(['documents']);
    flaky.registerExportContributor({
      module: 'documents',
      exportPart: () => {
        calls++;
        if (calls === 1)
          return Promise.reject(Object.assign(new Error('serialization'), { code: '40001' }));
        return Promise.resolve({ ok: true });
      },
    });
    await assert.rejects(
      t.assemble(a.packageId, { registries: flaky }, { attempt: 1, maxAttempts: 3 }),
      /serialization/,
    );
    assert.equal(
      (await row(`SELECT status FROM privacy.export_package WHERE id = $1`, [a.packageId]))[
        'status'
      ],
      'assembling',
    );
    assert.equal(
      (await t.assemble(a.packageId, { registries: flaky }, { attempt: 2, maxAttempts: 3 })).status,
      'ready',
    );

    // Permanent: not retried.
    const b = await t.approvedExport(await mk());
    const broken = registries(['documents']);
    broken.registerExportContributor({
      module: 'documents',
      exportPart: () => Promise.reject(new Error('bug')),
    });
    const f = await t.assemble(b.packageId, { registries: broken });
    assert.deepEqual(f, { status: 'failed', code: 'privacy.assembly_failed' });

    // The last attempt of a transient error also ends as failed.
    const c = await t.approvedExport(await mk());
    const last = registries(['documents']);
    last.registerExportContributor({
      module: 'documents',
      exportPart: () => Promise.reject(Object.assign(new Error('deadlock'), { code: '40P01' })),
    });
    assert.equal(
      (await t.assemble(c.packageId, { registries: last }, { attempt: 3, maxAttempts: 3 })).status,
      'failed',
    );

    // A store outage: failed, and no object is left.
    const d = await t.approvedExport(await mk());
    const before = t.store.objects.size;
    t.store.failPut = true;
    try {
      assert.equal((await t.assemble(d.packageId)).status, 'failed');
    } finally {
      t.store.failPut = false;
    }
    assert.equal(t.store.objects.size, before);

    // Over the size limit.
    const e = await t.approvedExport(await mk());
    const big = await t.assemble(e.packageId, { maxBytes: 100 });
    assert.deepEqual(big, { status: 'failed', code: 'privacy.export_too_large' });
    assert.equal(t.store.objects.size, before);
  });

  test('a merge while the package is assembling restarts the assembly for the survivor and the merged IDs', async () => {
    const merged = await mk();
    const survivor = await mk();
    const a = await t.approvedExport(merged);
    let first = true;
    const reg = registries(['documents']);
    reg.registerExportContributor({
      module: 'documents',
      async exportPart(tx, ids, requestId) {
        if (first) {
          first = false;
          const m = await t.merge(survivor.patientId, merged.patientId);
          assert.equal(m.result.status, 'completed', JSON.stringify(m.result));
        }
        return registries()
          .exportContributors()
          .find((c) => c.module === 'documents')!
          .exportPart(tx, ids, requestId);
      },
    });
    const out = await t.assemble(a.packageId, { registries: reg });
    assert.equal(out.status, 'ready', JSON.stringify(out));
    const pk = await row(
      `SELECT patient_id, object_key FROM privacy.export_package WHERE id = $1`,
      [a.packageId],
    );
    assert.equal(pk['patient_id'], survivor.patientId, 'the package followed the patient');
    const bundle = t.store.read(String(pk['object_key']));
    assert.deepEqual(
      [...(bundle.manifest['patientIds'] as string[])].sort(),
      [merged.patientId, survivor.patientId].sort(),
    );
    assert.equal(t.store.objects.size >= 1, true);
  });

  // ---- merge participant ---------------------------------------------------------------------------------------------------
  test('merge: R requests and packages move to the survivor, K ones stay, and found = re-pointed + kept', async () => {
    const merged = await mk();
    const survivor = await mk();
    const live = String((await req(merged, 'correction'))['id']); // received: R
    const gone = String((await req(merged, 'export'))['id']);
    assert.equal((await t.decide(gone, 'refuse', 'Refused for the merge test.')).status, 200); // refused: K
    const done = await finished(merged); // fulfilled request (K) with a ready package (R)
    const m = await t.merge(survivor.patientId, merged.patientId);
    assert.equal(m.result.status, 'completed', JSON.stringify(m.result));
    if (m.result.status !== 'completed') return;
    const rq = m.result.counts['privacy.request'];
    const pg = m.result.counts['privacy.export_package'];
    assert.deepEqual(rq, { found: 3, repointed: 1, resolved: 0, kept: 2 });
    assert.deepEqual(pg, { found: 1, repointed: 1, resolved: 0, kept: 0 });
    const where = async (id: string): Promise<unknown> =>
      (await row(`SELECT patient_id FROM privacy.request WHERE id = $1`, [id]))['patient_id'];
    assert.equal(await where(live), survivor.patientId);
    assert.equal(await where(gone), merged.patientId);
    assert.equal(await where(done.requestId), merged.patientId);
    assert.equal(
      (await row(`SELECT patient_id FROM privacy.export_package WHERE id = $1`, [done.packageId]))[
        'patient_id'
      ],
      survivor.patientId,
    );
    // The survivor's session reaches the request that moved and the package (through the closure of its IDs).
    const dl = await t.pcall(
      survivor.session,
      'POST',
      `/api/v1/privacy-requests/${live}/export/download-url`,
    );
    assert.equal(dl.status, 409, 'a correction request has no package');
  });

  // ---- staff create, slices, RLS ----------------------------------------------------------------------------------------------
  test('staff with privacy.request.create_for_patient create a request for a patient in scope, and read nothing back', async () => {
    const p = await mk();
    const r = await t.scall(t.desk, 'POST', `/api/v1/patients/${p.patientId}/privacy-requests`, {
      kind: 'access',
      detail: 'asked at the desk',
    });
    assert.equal(r.status, 201, r.body);
    assert.equal(r.json()['channel'], 'staff');
    assert.equal(r.json()['status'], 'received');
    const id = String(r.json()['id']);
    // Compliance sees it and the patient sees it.
    assert.ok(
      (
        (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests')).json()[
          'items'
        ] as Record<string, unknown>[]
      ).some((x) => x['id'] === id),
    );
    assert.ok(
      (
        (await t.pcall(p.session, 'GET', '/api/v1/privacy-requests')).json()['items'] as Record<
          string,
          unknown
        >[]
      ).some((x) => x['id'] === id),
    );
    // Staff cannot read the table.
    await t.as(t.deskScope(), async (tx) => {
      assert.equal(await count(tx, `SELECT count(*)::int AS n FROM privacy.request`), 0);
    });
    // A staff member at another location cannot create for this patient; a patient-realm session cannot use the route; a deletion is recorded like any other kind.
    assert.equal(
      (
        await t.scall(t.deskB, 'POST', `/api/v1/patients/${p.patientId}/privacy-requests`, {
          kind: 'export',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await t.pcall(p.session, 'POST', `/api/v1/patients/${p.patientId}/privacy-requests`, {
          kind: 'export',
        })
      ).status,
      403,
    );
    const del = await t.scall(t.desk, 'POST', `/api/v1/patients/${p.patientId}/privacy-requests`, {
      kind: 'deletion',
    });
    assert.equal(del.json()['status'], 'received');
    assert.equal(
      (
        await t.scall(t.desk, 'POST', `/api/v1/patients/${p.patientId}/privacy-requests`, {
          kind: 'bogus',
        })
      ).status,
      422,
    );
  });

  test('validation: kind, detail and bodies are checked on the server', async () => {
    const p = await mk();
    for (const body of [
      {},
      { kind: 'delete' },
      { kind: 'export', detail: 7 },
      { kind: 'export', detail: 'x'.repeat(5200) },
      'text',
    ]) {
      const r = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', body);
      assert.ok(
        [422, 400].includes(r.status),
        `${JSON.stringify(body).slice(0, 40)} -> ${r.status}`,
      );
    }
    // Wrong audience or realm.
    assert.equal(
      (await t.scall(t.desk, 'POST', '/api/v1/privacy-requests', { kind: 'export' })).status,
      403,
    );
    assert.equal((await t.pcall(p.session, 'GET', '/api/v1/admin/privacy-requests')).status, 403);
    assert.equal(
      (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests?status=bogus')).status,
      422,
    );
    assert.equal(
      (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests?limit=0')).status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.compliance, 'POST', `/api/v1/admin/privacy-requests/${uuidv7()}/decide`, {
          decision: 'approve',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await t.scall(t.compliance, 'POST', `/api/v1/admin/privacy-requests/${uuidv7()}/decide`, {
          decision: 'delete',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.scall(
          t.compliance,
          'POST',
          `/api/v1/admin/privacy-requests/not-a-uuid/verify-identity`,
          { method: 'in person' },
        )
      ).status,
      404,
    );
    const r = String((await req(p))['id']);
    assert.equal(
      (
        await t.scall(t.compliance, 'POST', `/api/v1/admin/privacy-requests/${r}/verify-identity`, {
          method: '',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.scall(
          t.compliance,
          'POST',
          `/api/v1/admin/privacy-requests/${r}/verify-identity`,
          {},
        )
      ).status,
      422,
    );
  });

  test('pagination: the admin list pages through requests newest first', async () => {
    const p = await mk();
    for (let i = 0; i < 3; i++) await req(p, 'access');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const r: { json(): Record<string, unknown> } = await t.scall(
        t.compliance,
        'GET',
        `/api/v1/admin/privacy-requests?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      for (const x of r.json()['items'] as Record<string, unknown>[]) seen.push(String(x['id']));
      cursor = (r.json()['nextCursor'] as string | null) ?? null;
      if (cursor === null) break;
    }
    const total = Number((await row(`SELECT count(*)::int AS n FROM privacy.request`))['n']);
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'no row twice');
    assert.equal(
      (await t.scall(t.compliance, 'GET', '/api/v1/admin/privacy-requests?cursor=garbage')).status,
      422,
    );
  });

  test('the compliance slice holds in both layers: a key opens its own tables only', async () => {
    const p = await mk();
    await req(p);
    const inc = await t.scall(t.compliance, 'POST', '/api/v1/admin/incidents', {
      title: 'Misdirected letter',
      description: 'A letter went to the wrong address.',
      severity: 'low',
      discoveredAt: new Date().toISOString(),
      patients: [{ patientId: p.patientId }],
    });
    assert.equal(inc.status, 201, inc.body);
    // API layer: an admin with no privacy permission is refused on every route; a patient too.
    for (const [m, path] of [
      ['GET', '/api/v1/admin/privacy-requests'],
      ['GET', '/api/v1/admin/incidents'],
    ] as const)
      assert.equal((await t.scall(t.orgAdmin, m, path)).status, 403, path);
    // Database layer: each slice key sees its own tables and nothing else; no key and no limited access see nothing.
    const cases: [string[], string, number][] = [
      [['privacy_requests'], 'privacy.request', 1],
      [['privacy_requests'], 'privacy.export_package', 1], // package METADATA is in the slice (6.7)
      [['privacy_requests'], 'privacy.incident', 0],
      [['privacy_requests'], 'privacy.incident_patient', 0],
      [['incidents'], 'privacy.request', 0],
      [['incidents'], 'privacy.incident', 1],
      [['incidents'], 'privacy.incident_patient', 1],
      [['audit_events', 'consents'], 'privacy.request', 0],
      [['audit_events', 'consents'], 'privacy.incident', 0],
      [[], 'privacy.request', 0],
    ];
    for (const [keys, table, min] of cases) {
      await t.as(adminScope(t.compliance, keys), async (tx) => {
        const n = await count(tx, `SELECT count(*)::int AS n FROM ${table}`);
        if (min === 0) assert.equal(n, 0, `${keys.join(',') || 'no key'} sees nothing in ${table}`);
        else assert.ok(n >= min, `${keys.join(',')} sees ${table}`);
      });
    }
    await t.as(
      { ...adminScope(t.compliance, ['privacy_requests', 'incidents']), phiAccess: 'off' },
      async (tx) => {
        assert.equal(await count(tx, `SELECT count(*)::int AS n FROM privacy.request`), 0);
      },
    );
    // The slice key does not reach the patient's record or the documents.
    await t.as(adminScope(t.compliance, ['privacy_requests', 'incidents']), async (tx) => {
      assert.equal(await count(tx, `SELECT count(*)::int AS n FROM documents.document`), 0);
      assert.equal(await count(tx, `SELECT count(*)::int AS n FROM clinical.note`), 0);
    });
  });

  test('rules no route can bypass: the tables refuse a hand-written change', async () => {
    const p = await mk();
    const requestId = String((await req(p))['id']);
    const bad = async (
      sql: string,
      params: unknown[],
      re: RegExp,
      who: ScopeSettings,
    ): Promise<void> =>
      assert.rejects(
        t.as(who, (tx) => tx.query(sql, params)),
        re,
      );
    const adm = adminScope(t.compliance, ['privacy_requests', 'incidents']);
    // Verification and decisions are the caller's own and ordered.
    await bad(
      `UPDATE privacy.request SET status = 'in_progress', decided_by_person_id = $2::uuid, decided_at = now(), verified_at = now(), verified_by_person_id = $2::uuid, verification_method = 'self' WHERE id = $1::uuid`,
      [requestId, t.compliance.seeded.personId],
      /./,
      adm,
    );
    await bad(
      `UPDATE privacy.request SET status = 'identity_verified', verification_method = 'by hand', verified_by_person_id = $2::uuid, verified_at = now() WHERE id = $1::uuid`,
      [requestId, uuidv7()],
      /identity is verified by compliance|23503|PS001/i,
      adm,
    );
    // The patient cannot move their own request (no update policy for the patient audience): zero rows.
    await t.as(patScope(p), async (tx) => {
      const u = await tx.query(
        `UPDATE privacy.request SET status = 'refused', decided_at = now(), decision_reason = 'I changed my mind about it' WHERE id = $1`,
        [requestId],
      );
      assert.equal(u.rowCount, 0);
    });
    // Staff of the front desk cannot verify or decide.
    await t.as(t.deskScope(), async (tx) => {
      const u = await tx.query(
        `UPDATE privacy.request SET status = 'identity_verified' WHERE id = $1`,
        [requestId],
      );
      assert.equal(u.rowCount, 0);
    });
    // A patient cannot insert a request in a state of their choosing, for staff's channel, or as another principal.
    for (const [status, channel, by] of [
      ['in_progress', 'portal', p.session.seeded.principalId],
      ['received', 'staff', p.session.seeded.principalId],
      ['received', 'portal', t.compliance.seeded.principalId],
    ] as const)
      await bad(
        `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, status, due_at, created_by)
         VALUES ($1, $2, $3, 'export', $4, $5, $6, now() + interval '30 days', $4)`,
        [uuidv7(), ORG, p.patientId, by, channel, status],
        /./,
        patScope(p),
      );
    // Immutable columns.
    await t.k.sa.query('BEGIN');
    try {
      await assert.rejects(
        t.k.sa.query(`UPDATE privacy.request SET kind = 'access' WHERE id = $1`, [requestId]),
        /keeps its kind/,
      );
    } finally {
      await t.k.sa.query('ROLLBACK');
    }
    // Nothing is ever deleted.
    for (const table of ['privacy.request', 'privacy.export_package']) {
      await t.k.sa.query('BEGIN');
      try {
        await assert.rejects(t.k.sa.query(`DELETE FROM ${table}`), /never deleted|PS001/);
      } finally {
        await t.k.sa.query('ROLLBACK');
      }
    }
    // A package: only the worker readies it, only its patient releases it, failed and expired are final.
    const done = await finished(await mk());
    await t.as(adminScope(t.compliance, ['privacy_requests']), async (tx) => {
      const u = await tx.query(
        `UPDATE privacy.export_package SET status = 'released', released_at = now() WHERE id = $1`,
        [done.packageId],
      );
      assert.equal(u.rowCount, 0, 'compliance cannot release a package');
    });
    await assert.rejects(
      t.k.sa.query(
        `UPDATE privacy.export_package SET status = 'assembling', object_key = NULL WHERE id = $1`,
        [done.packageId],
      ),
      /illegal package step|check/i,
    );
    // The worker cannot make a request fulfilled that is not in progress, or approve one.
    await assert.rejects(
      t.worker.withScope(
        { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' },
        (tx) =>
          tx.query(`UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1`, [requestId]),
      ),
      /illegal request step|PS001|check/i,
    );
    // ... nor approve one, nor verify identity.
    for (const set of [
      `status = 'in_progress', decided_by_person_id = '${t.compliance.seeded.personId}', decided_at = now()`,
      `status = 'identity_verified', verification_method = 'by the worker', verified_at = now()`,
    ])
      await assert.rejects(
        t.worker.withScope(
          { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' },
          (tx) => tx.query(`UPDATE privacy.request SET ${set} WHERE id = $1`, [requestId]),
        ),
        /./,
      );
  });

  // ---- expiry -----------------------------------------------------------------------------------------------------------------
  test('a ready package expires: the download is refused after its time, and the daily job removes the object', async () => {
    const p = await mk();
    const done = await finished(p);
    const exp = new Date(
      String(
        (
          await row(`SELECT expires_at FROM privacy.export_package WHERE id = $1`, [done.packageId])
        )['expires_at'],
      ),
    );
    assert.ok(
      exp.getTime() > Date.now() + 6.9 * 86_400_000 &&
        exp.getTime() < Date.now() + 7.1 * 86_400_000,
      'seven days after creation (owner ruling C item 2)',
    );
    // Before the time: nothing to expire.
    assert.deepEqual(await t.w.expire(), { expired: 0, failed: 0 });
    assert.ok(t.store.has(done.key));
    // After the time: the route refuses at once (clock), then the job expires it and removes the object.
    t.clock.at = new Date(exp.getTime() + 1000);
    try {
      const dl = await t.pcall(
        p.session,
        'POST',
        `/api/v1/privacy-requests/${done.requestId}/export/download-url`,
      );
      assert.equal(dl.status, 409);
      assert.equal(code(dl), 'privacy.export_not_ready');
      // Every package of the earlier tests is past its time too: at least this one.
      const ex = await t.w.expire({ now: () => t.clock.at as Date });
      assert.ok(ex.expired >= 1 && ex.failed === 0, JSON.stringify(ex));
    } finally {
      t.clock.at = undefined;
    }
    assert.ok(!t.store.has(done.key));
    assert.equal(
      (await row(`SELECT status FROM privacy.export_package WHERE id = $1`, [done.packageId]))[
        'status'
      ],
      'expired',
    );
    assert.equal(
      (await row(`SELECT status FROM privacy.request WHERE id = $1`, [done.requestId]))['status'],
      'fulfilled',
    );
    // An expired package is final.
    await assert.rejects(
      t.k.sa.query(`UPDATE privacy.export_package SET status = 'ready' WHERE id = $1`, [
        done.packageId,
      ]),
      /final|PS001/,
    );
    // The job again does nothing.
    assert.deepEqual(await t.w.expire({ now: () => new Date(Date.now() + 30 * 86_400_000) }), {
      expired: 0,
      failed: 0,
    });
  });

  // ---- idempotency ------------------------------------------------------------------------------------------------------------
  test('POST /privacy-requests is idempotent: the same key replays the same request; a different body under it conflicts', async () => {
    const p = await mk();
    const key = randomUUID();
    const a = await t.pcall(
      p.session,
      'POST',
      '/api/v1/privacy-requests',
      { kind: 'access' },
      { 'idempotency-key': key },
    );
    const b = await t.pcall(
      p.session,
      'POST',
      '/api/v1/privacy-requests',
      { kind: 'access' },
      { 'idempotency-key': key },
    );
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.json()['id'], a.json()['id']);
    assert.equal(b.headers['idempotent-replay'], 'true');
    const c = await t.pcall(
      p.session,
      'POST',
      '/api/v1/privacy-requests',
      { kind: 'export' },
      { 'idempotency-key': key },
    );
    assert.equal(c.status, 409);
    assert.equal(code(c), 'kernel.idempotency_conflict');
    assert.equal(
      Number(
        (
          await row(`SELECT count(*)::int AS n FROM privacy.request WHERE patient_id = $1`, [
            p.patientId,
          ])
        )['n'],
      ),
      1,
    );
    // No key: 400.
    const none = await t.pcall(
      p.session,
      'POST',
      '/api/v1/privacy-requests',
      { kind: 'access' },
      { 'idempotency-key': '' },
    );
    assert.equal(none.status, 400);
  });

  // ---- incident register ---------------------------------------------------------------------------------------------------------
  test('BE20-F2: refusing an in-progress export closes its assembling package; the request can be neither retried nor stuck', async () => {
    const p = await mk();
    const requestId = String((await req(p, 'export', 'refuse me later'))['id']);
    assert.equal((await t.verify(requestId)).status, 200);
    const d = await t.decide(requestId, 'approve');
    assert.equal(d.status, 200, d.body);
    const packageId = String((d.json()['package'] as Record<string, unknown>)['id']);
    const bad = await t.decide(requestId, 'refuse', 'short');
    assert.equal(bad.status, 422);
    assert.equal(
      (await row(`SELECT status FROM privacy.export_package WHERE id = $1`, [packageId]))['status'],
      'assembling',
    );
    const r = await t.decide(requestId, 'refuse', 'The requester withdrew the request in writing');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json()['status'], 'refused');
    const pk = await row(`SELECT status, failure_code FROM privacy.export_package WHERE id = $1`, [
      packageId,
    ]);
    assert.equal(pk['status'], 'failed');
    assert.equal(pk['failure_code'], 'privacy.request_refused');
    // The table refuses the same step while the request is still live.
    const q = String((await req(p, 'export', 'second'))['id']);
    assert.equal((await t.verify(q)).status, 200);
    const d2 = await t.decide(q, 'approve');
    const pid2 = String((d2.json()['package'] as Record<string, unknown>)['id']);
    await assert.rejects(
      t.as(adminScope(t.compliance, ['privacy_requests']), (tx) =>
        tx.query(
          `UPDATE privacy.export_package SET status = 'failed', failure_code = 'privacy.request_refused' WHERE id = $1::uuid`,
          [pid2],
        ),
      ),
      /only the worker finishes an assembly/,
    );
  });

  test('incident register: create, list, update with If-Match, forward-only status, patients and events only added, final when closed', async () => {
    const p1 = await mk();
    const p2 = await mk();
    const ev = uuidv7();
    const disc = new Date(Date.now() - 3_600_000).toISOString();
    const c = await t.scall(t.compliance, 'POST', '/api/v1/admin/incidents', {
      title: 'Lost laptop',
      description: 'An encrypted laptop was lost.',
      severity: 'high',
      discoveredAt: disc,
      notificationDeadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      patients: [{ patientId: p1.patientId, auditEventIds: [ev] }],
    });
    assert.equal(c.status, 201, c.body);
    const id = String(c.json()['id']);
    assert.equal(c.json()['status'], 'open');
    assert.equal(c.headers['etag'], 'W/"1"');
    assert.deepEqual(c.json()['patients'], [{ patientId: p1.patientId, auditEventIds: [ev] }]);

    const list = await t.scall(t.compliance, 'GET', '/api/v1/admin/incidents');
    assert.ok((list.json()['items'] as Record<string, unknown>[]).some((x) => x['id'] === id));

    const patch = (body: Record<string, unknown>, ifMatch?: string): ReturnType<typeof t.scall> =>
      t.scall(
        t.compliance,
        'PATCH',
        '/api/v1/admin/incidents',
        { id, ...body },
        ifMatch === undefined ? {} : { 'if-match': ifMatch },
      );
    assert.equal((await patch({ status: 'investigating' })).status, 428, 'If-Match required');
    assert.equal((await patch({ status: 'investigating' }, 'W/"7"')).status, 412);
    const inv = await patch(
      {
        status: 'investigating',
        patients: [
          { patientId: p1.patientId, auditEventIds: [uuidv7()] },
          { patientId: p2.patientId },
        ],
      },
      'W/"1"',
    );
    assert.equal(inv.status, 200, inv.body);
    assert.equal(inv.json()['status'], 'investigating');
    assert.equal(inv.headers['etag'], 'W/"2"');
    const pats = inv.json()['patients'] as { patientId: string; auditEventIds: string[] }[];
    assert.equal(pats.length, 2);
    assert.equal(
      pats.find((x) => x.patientId === p1.patientId)?.auditEventIds.length,
      2,
      'events are added',
    );
    // Forward only.
    assert.equal(code(await patch({ status: 'open' }, 'W/"2"')), 'privacy.invalid_transition');
    assert.equal((await patch({ status: 'closed' }, 'W/"2"')).status, 200);
    assert.ok(
      (await row(`SELECT closed_at FROM privacy.incident WHERE id = $1`, [id]))['closed_at'] !==
        null,
    );
    // Final.
    assert.equal(
      code(await patch({ title: 'Renamed after closure' }, 'W/"3"')),
      'privacy.invalid_transition',
    );
    // BE20-F1: links are final too, through the route and through the table.
    const p3 = await mk();
    assert.equal(
      code(await patch({ patients: [{ patientId: p3.patientId }] }, 'W/"3"')),
      'privacy.invalid_transition',
    );
    assert.equal(
      code(
        await patch(
          { patients: [{ patientId: p2.patientId, auditEventIds: [uuidv7()] }] },
          'W/"3"',
        ),
      ),
      'privacy.invalid_transition',
    );
    await assert.rejects(
      t.as(adminScope(t.compliance, ['incidents']), (tx) =>
        tx.query(
          `INSERT INTO privacy.incident_patient (incident_id, patient_id, organisation_id, audit_event_ids, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, '{}', $4::uuid)`,
          [id, p3.patientId, ORG, t.compliance.seeded.principalId],
        ),
      ),
      /closed incident is final/,
    );
    await assert.rejects(
      t.as(adminScope(t.compliance, ['incidents']), (tx) =>
        tx.query(
          `UPDATE privacy.incident_patient SET audit_event_ids = audit_event_ids || $2::uuid[] WHERE incident_id = $1::uuid`,
          [id, [uuidv7()]],
        ),
      ),
      /closed incident is final/,
    );
    // Validation.
    const body = { title: 'T', description: 'D', severity: 'low', discoveredAt: disc };
    for (const bad of [
      { title: '' },
      { severity: 'extreme' },
      { discoveredAt: 'yesterday' },
      { discoveredAt: new Date(Date.now() + 86_400_000).toISOString() },
      { notificationDeadline: new Date(Date.now() - 86_400_000 * 2).toISOString() },
      { patients: [{ patientId: 'x' }] },
      { patients: [{ patientId: uuidv7() }] },
    ])
      assert.equal(
        (await t.scall(t.compliance, 'POST', '/api/v1/admin/incidents', { ...body, ...bad }))
          .status,
        422,
        JSON.stringify(bad),
      );
    // The patients of an incident only gain events.
    await t.k.sa.query('BEGIN');
    try {
      await assert.rejects(
        t.k.sa.query(
          `UPDATE privacy.incident_patient SET audit_event_ids = '{}' WHERE incident_id = $1 AND patient_id = $2`,
          [id, p1.patientId],
        ),
        /only added/,
      );
    } finally {
      await t.k.sa.query('ROLLBACK');
    }
    // Nothing is ever deleted.
    for (const table of ['privacy.incident', 'privacy.incident_patient']) {
      await t.k.sa.query('BEGIN');
      try {
        await assert.rejects(t.k.sa.query(`DELETE FROM ${table}`), /never deleted|PS001/);
      } finally {
        await t.k.sa.query('ROLLBACK');
      }
    }
    // Audited, without the patient's ID in the row.
    const au = await row(
      `SELECT count(*)::int AS n FROM audit.event WHERE resource_type = 'privacy.incident' AND resource_id = $1 AND patient_id IS NULL`,
      [id],
    );
    assert.ok(Number(au['n']) >= 3);
  });
});
