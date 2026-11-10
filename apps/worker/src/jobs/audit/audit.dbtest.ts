// Real-database tests for BE-01 (audit jobs, worker side) on PostgreSQL 17 with the real migrations and the real queue:
// TC-AU-08 (anchoring, tamper detection, audit_anchor_mismatch event) and TC-AU-07 (chunked export, size limit, audited).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/jobs/audit/audit.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import {
  createAuditTasks,
  defineAuditJobs,
  runAnchor,
  runExportChunk,
  runVerify,
} from './index.js';
import type { ExportSink } from './index.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be01_w_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const ORG = '00000000-0000-7000-8000-0000000000a1';
const PERSON = '00000000-0000-7000-8000-0000000000d2';
const PAT = '00000000-0000-7000-8000-0000000000e1';

class MemorySink implements ExportSink {
  chunks = new Map<number, string>();
  finalized: { exportId: string; chunks: number } | undefined;
  failNext = 0;
  putChunk(_id: string, chunk: number, b: Buffer): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('sink down'));
    }
    this.chunks.set(chunk, b.toString('utf8'));
    return Promise.resolve();
  }
  finalize(exportId: string, chunks: number): Promise<{ objectKey: string }> {
    this.finalized = { exportId, chunks };
    return Promise.resolve({ objectKey: `exports/${exportId}.ndjson.enc` });
  }
}

describe('audit jobs on PostgreSQL 17 (BE-01)', () => {
  const registry = new JobRegistry();
  defineAuditJobs(registry);
  registry.defineJob({
    name: 'notifications.on_anchor_mismatch',
    maxAttempts: 3,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  });
  registry.registerHandler('audit.anchor_mismatch', 'notifications');
  const queue = new Queue(registry, 'worker');
  const sink = new MemorySink();
  let admin: {
    query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
  let pool: { end(): Promise<void> };
  let db: KernelDb;

  const insertEvents = async (
    n: number,
    startMinutesAgo: number,
    tag: string,
  ): Promise<string[]> => {
    // One event per `i`, spread one every 20 s into the past, written by app_worker as a system job would.
    const ids: string[] = [];
    await db.withScope(
      { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' },
      async (tx) => {
        for (let i = 0; i < n; i++) {
          const r = await tx.query(
            `INSERT INTO audit.event (event_id, occurred_at, organisation_id, job_id, realm, audience, action, resource_type, patient_id, outcome)
           VALUES (gen_random_uuid(), now() - make_interval(secs => $1::int), $2, $3, 'worker', 'system', 'view', 'clinical.note', $4, 'allowed')
           RETURNING event_id`,
            [startMinutesAgo * 60 - i * 20, ORG, `test:${tag}`, PAT],
          );
          ids.push(String(r.rows[0]?.event_id));
        }
      },
    );
    return ids;
  };
  const queuedJobs = async (task: string): Promise<number> =>
    Number(
      (await admin.query(`SELECT count(*) AS n FROM queue.jobs WHERE task_identifier = $1`, [task]))
        .rows[0]?.n,
    );

  before(async () => {
    const a = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
    await a.connect();
    await a.query(`CREATE DATABASE ${dbName}`);
    await a.end();
    const env = {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username),
      EHR_DB_MIGRATE_URL: urlFor('app_owner'),
    };
    for (const cmd of ['bootstrap', 'migrate'])
      execFileSync(process.execPath, [`${root}db/tools/migrate.mjs`, cmd], {
        env,
        stdio: 'inherit',
      });
    await installQueue(urlFor('app_owner'));
    const w = new pg.Client({ connectionString: urlFor('app_worker') }).on(
      'error',
      () => undefined,
    );
    await w.connect();
    await syncTaskTypes(w, registry);
    await w.end();
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) }).on(
      'error',
      () => undefined,
    );
    await (admin as never as { connect(): Promise<void> }).connect();
    pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 }).on(
      'error',
      () => undefined,
    );
    db = new KernelDb(pool as never);
  });
  after(async () => {
    await pool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  describe('TC-AU-08: anchoring and verification', () => {
    let ids: string[] = [];
    test('nothing to anchor yet', async () => {
      assert.deepEqual(await runAnchor(db, ORG, { watermarkSeconds: 1 }), {
        status: 'skipped',
        reason: 'no_events',
      });
    });

    test('anchors chain in steps of at most maxRange, each over a closed range, and a second run is a no-op', async () => {
      ids = await insertEvents(30, 12, 'a'); // 12 minutes ago, one per 20 s: ~10 minutes of rows
      const results = [];
      for (let i = 0; i < 20; i++) {
        const r = await runAnchor(db, ORG, { watermarkSeconds: 1, maxRangeSeconds: 120 });
        if (r.status !== 'anchored') break;
        results.push(r);
      }
      assert.ok(results.length >= 4, `expected several chained anchors, got ${results.length}`);
      assert.equal(
        results.reduce((s, r) => s + r.rowCount, 0),
        30,
        'every row is in exactly one anchor',
      );
      const a = (
        await admin.query(
          `SELECT id, from_ts, to_ts, row_count, prev_hash, hash, late_rows FROM audit.anchor ORDER BY to_ts`,
        )
      ).rows;
      assert.equal(a.length, results.length);
      assert.deepEqual(a[0]?.prev_hash, Buffer.alloc(32), 'genesis link');
      for (let i = 1; i < a.length; i++) {
        assert.deepEqual(a[i]?.prev_hash, a[i - 1]?.hash, `link ${i}`);
        assert.deepEqual(a[i]?.from_ts, a[i - 1]?.to_ts, `contiguous ${i}`);
      }
      assert.ok(a.every((x) => x.late_rows === 0));
      assert.deepEqual(await runAnchor(db, ORG, { watermarkSeconds: 1, maxRangeSeconds: 120 }), {
        status: 'skipped',
        reason: 'up_to_date',
      });
    });

    test('verification of untouched data passes and reports the partition horizon', async () => {
      const v = await runVerify(db, ORG, { queue });
      assert.deepEqual(v.mismatches, []);
      assert.ok(v.checked >= 4);
      assert.ok((v.partitionHorizonDays ?? 0) > 300, `horizon ${v.partitionHorizonDays}`);
      assert.equal(await queuedJobs('notifications.on_anchor_mismatch'), 0);
    });

    test('two concurrent anchor jobs never fork the chain: one writes, the others skip', async () => {
      await insertEvents(3, 0, 'b'); // at the present moment, after every closed range
      // A negative watermark is a test hook: it closes the current minute so there is something to anchor now.
      const opts = { watermarkSeconds: -60, maxRangeSeconds: 3600 };
      const rs = await Promise.all([
        runAnchor(db, ORG, opts),
        runAnchor(db, ORG, opts),
        runAnchor(db, ORG, opts),
      ]);
      assert.equal(rs.filter((r) => r.status === 'anchored').length, 1, JSON.stringify(rs));
      assert.ok(
        rs
          .filter((r) => r.status === 'skipped')
          .every(
            (r) => r.status === 'skipped' && (r.reason === 'locked' || r.reason === 'up_to_date'),
          ),
      );
      const heads = (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit.anchor a WHERE NOT EXISTS (SELECT 1 FROM audit.anchor b WHERE b.prev_hash = a.hash)`,
        )
      ).rows[0]?.n;
      assert.equal(heads, 1, 'a single chain head');
      assert.deepEqual((await runVerify(db, ORG)).mismatches, []);
    });

    test('a row changed by a DBA is detected: audit_anchor_mismatch is published, once per anchor and kind', async () => {
      const victim = ids[7] as string;
      // Owner-level tamper: a superuser switches the append-only trigger off for the session (this is what SAR-10 defends against).
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `UPDATE audit.event SET resource_type = 'clinical.tampered' WHERE event_id = $1`,
        [victim],
      );
      await admin.query(`COMMIT`);
      const v = await runVerify(db, ORG, { queue });
      assert.equal(v.mismatches.length, 1, JSON.stringify(v.mismatches));
      assert.equal(v.mismatches[0]?.kind, 'root');
      assert.equal(await queuedJobs('notifications.on_anchor_mismatch'), 1);
      // The daily job repeated the same day publishes the same job key: still one job (idempotent by anchor and kind).
      await runVerify(db, ORG, { queue });
      assert.equal(await queuedJobs('notifications.on_anchor_mismatch'), 1);
      const payload = (
        await admin.query(
          `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'notifications.on_anchor_mismatch'`,
        )
      ).rows[0]?.payload as Record<string, unknown>;
      assert.equal(payload.kind, 'root');
      assert.equal(payload.organisationId, ORG);
      assert.ok(payload.anchorId);
      // Put the row back: verification is clean again (the tamper, not the verifier, was the problem).
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `UPDATE audit.event SET resource_type = 'clinical.note' WHERE event_id = $1`,
        [victim],
      );
      await admin.query(`COMMIT`);
      assert.deepEqual((await runVerify(db, ORG)).mismatches, []);
    });

    test('a deleted row (count changes) and an inserted row inside an anchored range are detected', async () => {
      const victim = ids[3] as string;
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `CREATE TEMP TABLE saved_row AS SELECT * FROM audit.event WHERE event_id = $1`,
        [victim],
      );
      const del = await admin.query(
        `DELETE FROM audit.event WHERE event_id = $1 RETURNING event_id`,
        [victim],
      );
      await admin.query(`COMMIT`);
      assert.equal(del.rows.length, 1);
      const v = await runVerify(db, ORG);
      assert.deepEqual(v.mismatches.map((m) => m.kind).sort(), ['root', 'row_count']);
      // Put the identical row back (every column, microseconds included): clean again.
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(`INSERT INTO audit.event SELECT * FROM saved_row`);
      await admin.query(`COMMIT`);
      assert.deepEqual((await runVerify(db, ORG)).mismatches, []);
      // A forged extra row with an old timestamp is a mismatch, and the next anchor counts it as late.
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `INSERT INTO audit.event (event_id, occurred_at, organisation_id, job_id, realm, audience, action, resource_type, outcome)
         SELECT gen_random_uuid(), min(occurred_at) + interval '1 second', $1, 'forged', 'worker', 'system', 'view', 'x.y', 'allowed'
           FROM audit.event WHERE job_id = 'test:a'`,
        [ORG],
      );
      await admin.query(`COMMIT`);
      assert.deepEqual((await runVerify(db, ORG)).mismatches.map((m) => m.kind).sort(), [
        'root',
        'row_count',
      ]);
    });

    test('a broken chain link and a rewritten anchor hash are detected', async () => {
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `UPDATE audit.anchor SET prev_hash = decode(repeat('ab', 32), 'hex') WHERE id = (SELECT max(id) FROM audit.anchor)`,
      );
      await admin.query(`COMMIT`);
      const kinds = (await runVerify(db, ORG)).mismatches.map((m) => m.kind);
      assert.ok(kinds.includes('chain_link'), kinds.join(','));
      assert.ok(kinds.includes('hash'), kinds.join(','));
    });

    test('BR-BE01-02: verification covers older anchored ranges, not just recent ones', async () => {
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(
        `UPDATE audit.anchor SET created_at = now() - interval '30 days' WHERE id = (SELECT min(id) FROM audit.anchor)`,
      );
      await admin.query(`DELETE FROM audit.event WHERE job_id = 'forged'`);
      await admin.query(`COMMIT`);
      // A clean chain stays clean in both modes (earlier tests leave the chain-link tamper; ignore that kind here).
      const kindsOf = async (o: { lookbackDays?: number }): Promise<string[]> =>
        (await runVerify(db, ORG, o)).mismatches
          .filter((m) => m.kind === 'root' || m.kind === 'row_count')
          .map((m) => m.kind);
      assert.deepEqual(await kindsOf({}), []);
      await admin.query(`BEGIN`);
      await admin.query(`SET LOCAL session_replication_role = replica`);
      const ch = await admin.query(
        `UPDATE audit.event SET resource_type = 'tampered.old'
          WHERE ctid = (SELECT e.ctid FROM audit.event e, audit.anchor a
                         WHERE a.id = (SELECT min(id) FROM audit.anchor)
                           AND e.organisation_id = $1 AND e.occurred_at >= a.from_ts AND e.occurred_at < a.to_ts
                           LIMIT 1)
        RETURNING 1`,
        [ORG],
      );
      await admin.query(`COMMIT`);
      assert.equal(ch.rows.length, 1);
      assert.ok((await kindsOf({})).includes('root'), 'full verification sees the old range');
      assert.deepEqual(
        await kindsOf({ lookbackDays: 3 }),
        [],
        'the lookback window alone does not',
      );
    });

    test('nobody can UPDATE or DELETE an anchor (privilege error for roles, trigger for a superuser)', async () => {
      for (const user of ['app_api', 'app_worker', 'app_owner', 'audit_archiver']) {
        const c = new pg.Client({ connectionString: urlFor(user) }).on('error', () => undefined);
        await c.connect();
        try {
          await assert.rejects(
            c.query(`DELETE FROM audit.anchor`),
            (e: { code?: string }) => e.code === '42501',
          );
          await assert.rejects(
            c.query(`UPDATE audit.anchor SET late_rows = 1`),
            (e: { code?: string }) => e.code === '42501',
          );
        } finally {
          await c.end();
        }
      }
      await assert.rejects(admin.query(`DELETE FROM audit.anchor`), /append-only/);
      await assert.rejects(admin.query(`UPDATE audit.anchor SET late_rows = 1`), /append-only/);
    });
  });

  describe('TC-AU-07: the export job is chunked, size limited and itself audited', () => {
    const exportId = '00000000-0000-7000-8000-0000000e0001';
    const createJob = async (id: string, filter: Record<string, string>): Promise<void> => {
      await admin.query(
        `INSERT INTO audit.export_job (id, organisation_id, requested_by_person_id, reason, filter, elevation_id)
         VALUES ($1, $2, $3, 'accounting of disclosures for the patient', $4::jsonb, gen_random_uuid())`,
        [id, ORG, PERSON, JSON.stringify(filter)],
      );
    };
    test('runs chunk by chunk (each chunk enqueues the next), writes every matching row once in order, then is ready and audited', async () => {
      const total = Number(
        (
          await admin.query(
            `SELECT count(*) AS n FROM audit.event WHERE patient_id = $1 AND resource_type = 'clinical.note'`,
            [PAT],
          )
        ).rows[0]?.n,
      );
      await createJob(exportId, {
        from: '2020-01-01T00:00:00Z',
        to: '2100-01-01T00:00:00Z',
        patientId: PAT,
        resourceType: 'clinical.note',
      });
      const opts = { sink, queue, chunkRows: 7 };
      let chunk = 0;
      let last;
      for (;;) {
        last = await runExportChunk(db, ORG, exportId, chunk, opts);
        if (last.status !== 'chunk') break;
        assert.equal(last.rows, 7);
        assert.equal(
          await queuedJobs('audit.export'),
          chunk + 1,
          'next chunk enqueued in the same transaction',
        );
        chunk++;
      }
      assert.equal(last.status, 'ready');
      const lines = [...sink.chunks.entries()]
        .sort((a, b) => a[0] - b[0])
        .flatMap(([, t]) => t.trim().split('\n'));
      assert.ok(total >= 28, `rows in scope ${total}`);
      assert.equal(lines.length, total);
      const parsed = lines.map((l) => JSON.parse(l) as { event_id: string; occurred_at: string });
      assert.equal(new Set(parsed.map((p) => p.event_id)).size, total, 'no row twice');
      assert.deepEqual(
        [...parsed].map((p) => p.occurred_at),
        [...parsed].map((p) => p.occurred_at).sort(),
        'ordered',
      );
      const j = (
        await admin.query(
          `SELECT status, row_count, object_key, expires_at, chunks_done FROM audit.export_job WHERE id = $1`,
          [exportId],
        )
      ).rows[0];
      assert.equal(j?.status, 'ready');
      assert.equal(Number(j?.row_count), total);
      assert.equal(j?.object_key, `exports/${exportId}.ndjson.enc`);
      assert.ok(j?.expires_at);
      assert.deepEqual(sink.finalized, { exportId, chunks: Number(j?.chunks_done) });
      const ev = (
        await admin.query(
          `SELECT action, actor_person_id, reason, resource_id, audience, realm FROM audit.event WHERE job_id = $1`,
          [`audit.export:${exportId}`],
        )
      ).rows;
      assert.equal(ev.length, 1, 'the export itself is audited once');
      assert.deepEqual(
        { ...ev[0] },
        {
          action: 'export',
          actor_person_id: PERSON,
          reason: 'accounting of disclosures for the patient',
          resource_id: exportId,
          audience: 'system',
          realm: 'worker',
        },
      );
    });
    test('re-running any chunk of a finished job is a no-op: no second audit row, no second object', async () => {
      const before = sink.chunks.size;
      assert.deepEqual(await runExportChunk(db, ORG, exportId, 0, { sink, queue, chunkRows: 7 }), {
        status: 'skipped',
        reason: 'finished',
      });
      assert.equal(sink.chunks.size, before);
      assert.equal(
        Number(
          (
            await admin.query(`SELECT count(*) AS n FROM audit.event WHERE job_id = $1`, [
              `audit.export:${exportId}`,
            ])
          ).rows[0]?.n,
        ),
        1,
      );
    });
    test('a sink failure leaves progress untouched; the retry of the same chunk succeeds (retry-safe)', async () => {
      const id = '00000000-0000-7000-8000-0000000e0002';
      await createJob(id, {
        from: '2020-01-01T00:00:00Z',
        to: '2100-01-01T00:00:00Z',
        patientId: PAT,
      });
      const s2 = new MemorySink();
      s2.failNext = 1;
      await assert.rejects(
        runExportChunk(db, ORG, id, 0, { sink: s2, queue, chunkRows: 10 }),
        /sink down/,
      );
      const mid = (
        await admin.query(
          `SELECT status, chunks_done, row_count FROM audit.export_job WHERE id = $1`,
          [id],
        )
      ).rows[0];
      assert.equal(mid?.status, 'running');
      assert.equal(mid?.chunks_done, 0);
      const r = await runExportChunk(db, ORG, id, 0, { sink: s2, queue, chunkRows: 10 });
      assert.equal(r.status, 'chunk');
      await assert.rejects(
        runExportChunk(db, ORG, id, 3, { sink: s2, queue, chunkRows: 10 }),
        /out of order/,
      );
    });
    test('BR-BE01-03: overlapping runs of the same chunk write one export audit row', async () => {
      const id = '00000000-0000-7000-8000-0000000e0009';
      await createJob(id, {
        from: '2020-01-01T00:00:00Z',
        to: '2100-01-01T00:00:00Z',
        patientId: PAT,
      });
      const o = { sink: new MemorySink(), queue, chunkRows: 100000 };
      const rs = await Promise.all([
        runExportChunk(db, ORG, id, 0, o),
        runExportChunk(db, ORG, id, 0, o),
      ]);
      assert.deepEqual(rs.map((r) => r.status).sort(), ['ready', 'skipped']);
      const n = (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit.event WHERE action = 'export' AND resource_id = $1`,
          [id],
        )
      ).rows[0]?.n;
      assert.equal(n, 1);
    });
    test('size limit: when the rows exceed audit_export_max_rows the job fails and writes nothing past the limit', async () => {
      const id = '00000000-0000-7000-8000-0000000e0003';
      await createJob(id, { from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' });
      await admin.query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'audit_export_max_rows', '12'::jsonb, 'int')`,
        [ORG],
      );
      const s3 = new MemorySink();
      const opts = { sink: s3, queue, chunkRows: 5 };
      const results = [];
      for (let c = 0; c < 10; c++) {
        const r = await runExportChunk(db, ORG, id, c, opts);
        results.push(r.status);
        if (r.status !== 'chunk') break;
      }
      assert.deepEqual(results, ['chunk', 'chunk', 'failed']);
      const j = (
        await admin.query(`SELECT status, row_count FROM audit.export_job WHERE id = $1`, [id])
      ).rows[0];
      assert.equal(j?.status, 'failed');
      assert.ok(Number(j?.row_count) <= 12);
      assert.equal(s3.finalized, undefined);
      assert.equal(
        Number(
          (
            await admin.query(`SELECT count(*) AS n FROM audit.event WHERE job_id = $1`, [
              `audit.export:${id}`,
            ])
          ).rows[0]?.n,
        ),
        0,
        'a failed export is not recorded as exported',
      );
    });
    test('the task table refuses a payload for another organisation or a malformed id', async () => {
      const tasks = createAuditTasks({
        db,
        queue,
        sink,
        archive: {} as never,
        orgId: ORG,
        log: { warn() {}, error() {}, info() {} } as never,
      });
      const helpers = { job: { attempts: 1, max_attempts: 3 } } as never;
      const run = async (payload: object): Promise<void> => {
        await tasks['audit.export']!(payload, helpers);
      };
      await assert.rejects(
        run({ exportId, organisationId: '00000000-0000-7000-8000-0000000000ff', chunk: 0 }),
        /bad payload/,
      );
      await assert.rejects(run({ exportId: 'nope', organisationId: ORG, chunk: 0 }), /bad payload/);
      await assert.rejects(run({ exportId, organisationId: ORG, chunk: -1 }), /bad payload/);
    });
    test('the job types are known to the queue: audit.export may be enqueued by the API tier, anchor and verify may not', async () => {
      const r = (
        await admin.query(
          `SELECT task_identifier AS name, job_class, api_enqueue FROM queue_api.task_type WHERE task_identifier LIKE 'audit.%' ORDER BY task_identifier`,
        )
      ).rows;
      assert.deepEqual(
        r.map((x) => `${x.name}:${x.job_class}:${x.api_enqueue}`),
        [
          'audit.anchor:system:false',
          'audit.archive_anchors:system:false',
          'audit.export:job:true',
          'audit.verify_anchors:system:false',
        ],
      );
    });
  });
});
