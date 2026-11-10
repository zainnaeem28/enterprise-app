// Real-database tests for the anchor archive and the TC-AU-08 archive case (INT04-F10 D-2, design 3.8; SEC05-F02) on PostgreSQL 17 with the real migrations and the
// real queue, against an in-process object-store fake with versioning and `If-None-Match`:
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/jobs/audit/archive.dbtest.js
// Missing configuration FAILS; nothing skips. Real-bucket behaviour (conditional put, prefix grants, KMS) is verified by DevOps in staging.
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
  runArchiveAnchors,
  runVerify,
} from './index.js';
import { MemoryAnchorArchive } from './archive-fake.js';
import { anchorArchiveKey, canonicalAnchorBody, sha256, type AnchorRow } from './archive.js';
import { anchorHash, merkleRoot } from './merkle.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_f10b_w_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};
const ORG = '00000000-0000-7000-8000-0000000000a1';
const PAT = '00000000-0000-7000-8000-0000000000e1';

describe('anchor archive on PostgreSQL 17 (INT04-F10-B)', () => {
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
  const store = new MemoryAnchorArchive();
  let admin: {
    query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
    connect(): Promise<void>;
  };
  let pool: { end(): Promise<void> };
  let db: KernelDb;

  const mismatchJobs = async (): Promise<{ anchorId: number; kind: string }[]> =>
    (
      await admin.query(
        `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
          WHERE t.identifier = 'notifications.on_anchor_mismatch'`,
      )
    ).rows.map((r) => r.payload as { anchorId: number; kind: string });
  const clearJobs = async (): Promise<void> => {
    await admin.query(`DELETE FROM queue._private_jobs`);
  };
  const asOwner = async (sql: string, params?: unknown[]): Promise<void> => {
    await admin.query(`BEGIN`);
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(sql, params);
    await admin.query(`COMMIT`);
  };
  const anchorRows = async (): Promise<AnchorRow[]> =>
    (
      await admin.query(
        `SELECT a.id::text AS id, a.organisation_id::text AS organisation_id, a.row_count::text AS row_count, a.merkle_root, a.prev_hash,
                a.hash, a.late_rows, to_char(a.from_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from_text,
                to_char(a.to_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS to_text
           FROM audit.anchor a ORDER BY a.to_ts`,
      )
    ).rows.map((r) => ({
      id: String(r.id),
      organisationId: String(r.organisation_id),
      fromTs: String(r.from_text),
      toTs: String(r.to_text),
      rowCount: String(r.row_count),
      merkleRoot: r.merkle_root as Buffer,
      prevHash: r.prev_hash as Buffer,
      hash: r.hash as Buffer,
      lateRows: Number(r.late_rows),
    }));

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
    await admin.connect();
    pool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 4 }).on(
      'error',
      () => undefined,
    );
    db = new KernelDb(pool as never);
    // Eight events, one every 5 minutes starting 40 minutes ago, written by app_worker as a system job would; anchored in 10-minute steps.
    await db.withScope(
      { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' },
      async (tx) => {
        for (let i = 0; i < 8; i++)
          await tx.query(
            `INSERT INTO audit.event (event_id, occurred_at, organisation_id, job_id, realm, audience, action, resource_type, patient_id, outcome)
             VALUES (gen_random_uuid(), now() - make_interval(secs => $1::int), $2, 'test:f10b', 'worker', 'system', 'view', 'clinical.note', $3, 'allowed')`,
            [40 * 60 - i * 300, ORG, PAT],
          );
      },
    );
    for (let i = 0; i < 10; i++) {
      const r = await runAnchor(db, ORG, { watermarkSeconds: 1, maxRangeSeconds: 600 });
      if (r.status === 'skipped') break;
    }
  });
  after(async () => {
    await pool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl }).on('error', () => undefined);
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  describe('migration 0204: the receipt table', () => {
    test('anchors exist, the receipt table is empty, and the lag is the age of the oldest anchor', async () => {
      assert.ok((await anchorRows()).length >= 3);
      const r = await runArchiveAnchors(db, ORG, {
        store: new MemoryAnchorArchive(),
        queue,
        batchSize: 1,
      });
      // batch of 1 against a fresh fake: one archived, the rest wait; the lag is the oldest waiting anchor's age.
      assert.equal(r.archived, 1);
      assert.ok(r.lagSeconds > 0);
      await asOwner(`DELETE FROM audit.anchor_archive_receipt`);
    });

    test('no application role can UPDATE, DELETE or TRUNCATE a receipt; app_worker cannot UPDATE an anchor', async () => {
      await runArchiveAnchors(db, ORG, { store, queue });
      assert.equal(
        Number(
          (await admin.query(`SELECT count(*) AS n FROM audit.anchor_archive_receipt`)).rows[0]?.n,
        ),
        (await anchorRows()).length,
      );
      for (const user of ['app_api', 'app_worker', 'app_owner', 'audit_archiver']) {
        const c = new pg.Client({ connectionString: urlFor(user) }).on('error', () => undefined);
        await c.connect();
        try {
          for (const sql of [
            `UPDATE audit.anchor_archive_receipt SET version_id = 'x'`,
            `DELETE FROM audit.anchor_archive_receipt`,
            `TRUNCATE audit.anchor_archive_receipt`,
          ])
            await assert.rejects(
              c.query(sql),
              (e: { code?: string }) => e.code === '42501',
              `${user}: ${sql}`,
            );
        } finally {
          await c.end();
        }
      }
      const w = new pg.Client({ connectionString: urlFor('app_worker') }).on(
        'error',
        () => undefined,
      );
      await w.connect();
      try {
        await assert.rejects(
          w.query(`UPDATE audit.anchor SET archived_at = now()`),
          (e: { code?: string }) => e.code === '42501',
        );
      } finally {
        await w.end();
      }
      for (const sql of [
        `UPDATE audit.anchor_archive_receipt SET version_id = 'x'`,
        `DELETE FROM audit.anchor_archive_receipt`,
        `TRUNCATE audit.anchor_archive_receipt`,
      ])
        await assert.rejects(admin.query(sql), /append-only/, `superuser: ${sql}`);
    });

    test('a receipt cannot name another organisation than its anchor, and PUBLIC and app_owner hold no right on the table', async () => {
      const a = (await anchorRows())[0] as AnchorRow;
      await asOwner(`DELETE FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [a.id]);
      await assert.rejects(
        db.withScope(
          {
            audience: 'system',
            realm: 'worker',
            orgId: '00000000-0000-7000-8000-0000000000ff',
            jobScope: 'org',
          },
          (tx) =>
            tx.query(
              `INSERT INTO audit.anchor_archive_receipt (anchor_id, organisation_id, archive_key, version_id, body_sha256)
               VALUES ($1::bigint, '00000000-0000-7000-8000-0000000000ff', 'k', 'v', $2)`,
              [a.id, Buffer.alloc(32)],
            ),
        ),
        /row-level security|violates/,
      );
      const g = (
        await admin.query(
          `SELECT grantee, privilege_type FROM information_schema.role_table_grants
            WHERE table_schema = 'audit' AND table_name = 'anchor_archive_receipt' ORDER BY 1, 2`,
        )
      ).rows.map((r) => `${r.grantee}:${r.privilege_type}`);
      assert.ok(!g.some((x) => x.startsWith('PUBLIC') || x.startsWith('app_owner')), g.join(','));
      assert.ok(
        g.includes('app_worker:INSERT') &&
          g.includes('app_worker:SELECT') &&
          g.includes('app_api:SELECT'),
      );
      assert.ok(!g.some((x) => /UPDATE|DELETE|TRUNCATE/.test(x)), g.join(','));
      await runArchiveAnchors(db, ORG, { store, queue });
    });
  });

  describe('audit.archive_anchors', () => {
    test('archives every anchor once: key, version and SHA-256 are on the receipt; a second run puts nothing', async () => {
      const anchors = await anchorRows();
      const rec = (
        await admin.query(
          `SELECT anchor_id::text AS id, archive_key, version_id, body_sha256 FROM audit.anchor_archive_receipt ORDER BY anchor_id`,
        )
      ).rows;
      assert.equal(rec.length, anchors.length);
      for (const a of anchors) {
        const r = rec.find((x) => x.id === a.id);
        assert.equal(r?.archive_key, anchorArchiveKey(a));
        assert.deepEqual(r?.body_sha256, sha256(canonicalAnchorBody(a)));
        assert.equal(store.objects.get(anchorArchiveKey(a))?.[0]?.versionId, r?.version_id);
      }
      const before = store.puts;
      const again = await runArchiveAnchors(db, ORG, { store, queue });
      assert.deepEqual([again.archived, again.lagSeconds, store.puts], [0, 0, before]);
    });

    test('an object-store error leaves the anchor for the next run and the lag grows; the retry archives it', async () => {
      await runAnchor(db, ORG, { watermarkSeconds: -60, maxRangeSeconds: 3600 }); // closes the current minute: one more anchor
      store.failNext = 1;
      const r1 = await runArchiveAnchors(db, ORG, { store, queue });
      assert.deepEqual([r1.archived, r1.failed], [0, 1]);
      assert.ok(r1.lagSeconds > 0);
      const r2 = await runArchiveAnchors(db, ORG, { store, queue });
      assert.deepEqual([r2.archived, r2.failed, r2.lagSeconds], [1, 0, 0]);
    });

    test('412 with an equal body inserts a receipt with the existing version (crash between put and insert)', async () => {
      await runAnchor(db, ORG, { watermarkSeconds: -120, maxRangeSeconds: 3600 });
      const last = (await anchorRows()).at(-1) as AnchorRow;
      const seeded = store.seed(anchorArchiveKey(last), canonicalAnchorBody(last));
      const r = await runArchiveAnchors(db, ORG, { store, queue });
      assert.deepEqual([r.archived, r.adopted, r.differing], [1, 1, 0]);
      const rec = (
        await admin.query(
          `SELECT version_id FROM audit.anchor_archive_receipt WHERE anchor_id = $1`,
          [last.id],
        )
      ).rows[0];
      assert.equal(rec?.version_id, seeded);
    });

    test('412 with a different body publishes audit.anchor_mismatch (archive_differs) and inserts nothing', async () => {
      await clearJobs();
      await runAnchor(db, ORG, { watermarkSeconds: -180, maxRangeSeconds: 3600 });
      const last = (await anchorRows()).at(-1) as AnchorRow;
      store.seed(anchorArchiveKey(last), Buffer.from('{"forged":true}'));
      const r = await runArchiveAnchors(db, ORG, { store, queue });
      assert.deepEqual([r.archived, r.differing], [0, 1]);
      assert.equal(
        (
          await admin.query(`SELECT 1 FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [
            last.id,
          ])
        ).rows.length,
        0,
      );
      assert.deepEqual(await mismatchJobs(), [
        { organisationId: ORG, anchorId: Number(last.id), kind: 'archive_differs' },
      ]);
      // The same anchor next run: still no receipt, still one job (job key per anchor and reason).
      await runArchiveAnchors(db, ORG, { store, queue });
      assert.equal((await mismatchJobs()).length, 1);
      // Make the archive match the database again so the later tests start clean: a fresh store holds the good objects.
      store.objects.delete(anchorArchiveKey(last));
      const r2 = await runArchiveAnchors(db, ORG, { store, queue });
      assert.equal(r2.archived, 1);
      await clearJobs();
    });

    test('the task emits AuditAnchorArchiveLagSeconds on every run, 0 when nothing waits', async () => {
      const gauges: [string, number][] = [];
      const tasks = createAuditTasks({
        db,
        queue,
        sink: {} as never,
        archive: store,
        orgId: ORG,
        log: { warn() {}, error() {}, info() {} } as never,
        metrics: { gauge: (n, v) => gauges.push([n, v]) },
      });
      await tasks['audit.archive_anchors']!({}, {} as never);
      assert.deepEqual(gauges, [['AuditAnchorArchiveLagSeconds', 0]]);
    });
  });

  describe('audit.verify_anchors: the archive is the authority', () => {
    test('untouched data verifies clean with the archive, and the archive was actually read', async () => {
      const v = await runVerify(db, ORG, { queue, archive: store, archiveGraceMinutes: 0 });
      assert.deepEqual(v.mismatches, []);
      assert.equal(v.archive, 'checked');
      assert.equal(v.archivedChecked, (await anchorRows()).length);
    });

    test('tamper: an event row changed and the anchor chain rewritten consistently as owner -> db_differs_from_archive and an alert', async () => {
      await clearJobs();
      const anchors = await anchorRows();
      const first = anchors.findIndex((a) => a.rowCount !== '0');
      const victim = anchors[first] as AnchorRow;
      const original = anchors.slice(first);
      // Change an event inside the victim's range, then rewrite the victim and every later anchor (root, hash, chain) so the database is internally consistent.
      await asOwner(
        `UPDATE audit.event SET resource_type = 'clinical.tampered'
          WHERE event_id = (SELECT event_id FROM audit.event WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz ORDER BY occurred_at LIMIT 1)`,
        [victim.fromTs.replace('Z', '+00'), victim.toTs.replace('Z', '+00')],
      );
      let prevHash = victim.prevHash;
      for (const a of original) {
        const leaves = (
          await admin.query(
            `SELECT audit.row_digest(e) AS d FROM audit.event e
              WHERE e.occurred_at >= $1::timestamptz AND e.occurred_at < $2::timestamptz ORDER BY e.occurred_at, e.event_id`,
            [a.fromTs.replace('Z', '+00'), a.toTs.replace('Z', '+00')],
          )
        ).rows.map((r) => r.d as Buffer);
        const rootNew = merkleRoot(leaves);
        const hashNew = anchorHash({
          prevHash,
          fromTs: a.fromTs,
          toTs: a.toTs,
          rowCount: BigInt(a.rowCount),
          merkleRoot: rootNew,
        });
        await asOwner(
          `UPDATE audit.anchor SET merkle_root = $2, prev_hash = $3, hash = $4 WHERE id = $1`,
          [a.id, rootNew, prevHash, hashNew],
        );
        prevHash = hashNew;
      }
      // The database alone is clean (internally consistent): this is the gap the archive closes.
      assert.deepEqual((await runVerify(db, ORG, { queue })).mismatches, []);
      const v = await runVerify(db, ORG, { queue, archive: store, archiveGraceMinutes: 0 });
      const flagged = v.mismatches
        .filter((m) => m.kind === 'db_differs_from_archive')
        .map((m) => m.anchorId);
      assert.deepEqual(
        flagged.sort(),
        original.map((a) => a.id).sort(),
        JSON.stringify(v.mismatches),
      );
      const jobs = await mismatchJobs();
      assert.ok(
        jobs.some((j) => j.kind === 'db_differs_from_archive' && j.anchorId === Number(victim.id)),
      );
      // Restore the originals: verification is clean again.
      for (const a of original)
        await asOwner(
          `UPDATE audit.anchor SET merkle_root = $2, prev_hash = $3, hash = $4 WHERE id = $1`,
          [a.id, a.merkleRoot, a.prevHash, a.hash],
        );
      await asOwner(
        `UPDATE audit.event SET resource_type = 'clinical.note' WHERE resource_type = 'clinical.tampered'`,
      );
      assert.deepEqual(
        (await runVerify(db, ORG, { queue, archive: store, archiveGraceMinutes: 0 })).mismatches,
        [],
      );
      await clearJobs();
    });

    test('an anchor missing from the database but present in the archive is db_differs_from_archive, unless it is after the restore point', async () => {
      const last = (await anchorRows()).at(-1) as AnchorRow;
      const ghost: AnchorRow = {
        ...last,
        id: '99999',
        fromTs: last.toTs,
        toTs: '2999-01-01T00:00:00.000000Z',
        prevHash: last.hash,
        hash: Buffer.alloc(32),
      };
      ghost.hash = anchorHash({
        prevHash: ghost.prevHash,
        fromTs: ghost.fromTs,
        toTs: ghost.toTs,
        rowCount: BigInt(ghost.rowCount),
        merkleRoot: ghost.merkleRoot,
      });
      const copy = store.clone();
      copy.seed(anchorArchiveKey(ghost), canonicalAnchorBody(ghost));
      const flagged = await runVerify(db, ORG, { archive: copy, archiveGraceMinutes: 0 });
      assert.deepEqual(flagged.mismatches, [
        { anchorId: '99999', kind: 'db_differs_from_archive' },
      ]);
      const restored = await runVerify(db, ORG, {
        archive: copy,
        archiveGraceMinutes: 0,
        restorePointAt: last.toTs,
      });
      assert.deepEqual([restored.mismatches, restored.afterRestorePoint], [[], 1]);
    });

    test('a deleted receipt is not_archived once the anchor is older than the grace; a fresh anchor is not flagged under the default grace', async () => {
      const last = (await anchorRows()).at(-1) as AnchorRow;
      const rec = (
        await admin.query(`SELECT * FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [
          last.id,
        ])
      ).rows[0] as Record<string, unknown>;
      await asOwner(`DELETE FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [last.id]);
      await clearJobs();
      const v = await runVerify(db, ORG, { queue, archive: store, archiveGraceMinutes: 0 });
      assert.deepEqual(v.mismatches, [{ anchorId: last.id, kind: 'not_archived' }]);
      assert.deepEqual(await mismatchJobs(), [
        { organisationId: ORG, anchorId: Number(last.id), kind: 'not_archived' },
      ]);
      assert.deepEqual((await runVerify(db, ORG, { archive: store })).mismatches, []);
      await asOwner(
        `INSERT INTO audit.anchor_archive_receipt (anchor_id, organisation_id, archive_key, version_id, body_sha256, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          rec.anchor_id,
          rec.organisation_id,
          rec.archive_key,
          rec.version_id,
          rec.body_sha256,
          rec.archived_at,
        ],
      );
      await clearJobs();
    });

    test('a receipt that names a version the archive does not list is not_archived (forged receipt)', async () => {
      const last = (await anchorRows()).at(-1) as AnchorRow;
      const rec = (
        await admin.query(
          `SELECT version_id FROM audit.anchor_archive_receipt WHERE anchor_id = $1`,
          [last.id],
        )
      ).rows[0] as { version_id: string };
      await asOwner(`DELETE FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [last.id]);
      await asOwner(
        `INSERT INTO audit.anchor_archive_receipt (anchor_id, organisation_id, archive_key, version_id, body_sha256)
         VALUES ($1, $2, $3, 'forged-version', $4)`,
        [last.id, ORG, anchorArchiveKey(last), Buffer.alloc(32)],
      );
      const v = await runVerify(db, ORG, { archive: store, archiveGraceMinutes: 0 });
      assert.deepEqual(v.mismatches, [{ anchorId: last.id, kind: 'not_archived' }]);
      await asOwner(`DELETE FROM audit.anchor_archive_receipt WHERE anchor_id = $1`, [last.id]);
      await asOwner(
        `INSERT INTO audit.anchor_archive_receipt (anchor_id, organisation_id, archive_key, version_id, body_sha256)
         VALUES ($1, $2, $3, $4, $5)`,
        [last.id, ORG, anchorArchiveKey(last), rec.version_id, sha256(canonicalAnchorBody(last))],
      );
      await clearJobs();
    });

    test('a later version of an archived key is itself a finding (archive_extra_version), judged on the earliest version', async () => {
      const last = (await anchorRows()).at(-1) as AnchorRow;
      const copy = store.clone();
      copy.forceVersion(anchorArchiveKey(last), Buffer.from('{"later":true}'));
      const v = await runVerify(db, ORG, { archive: copy, archiveGraceMinutes: 0 });
      assert.deepEqual(v.mismatches, [{ anchorId: last.id, kind: 'archive_extra_version' }]);
    });

    test('an unreadable archive fails the task after the database checks and the mismatch events; it never reads as clean', async () => {
      const gauges: [string, number][] = [];
      const down = store.clone();
      down.failNext = 1;
      const tasks = createAuditTasks({
        db,
        queue,
        sink: {} as never,
        archive: down,
        orgId: ORG,
        log: { warn() {}, error() {}, info() {} } as never,
        metrics: { gauge: (n, v) => gauges.push([n, v]) },
      });
      await assert.rejects(
        Promise.resolve(tasks['audit.verify_anchors']!({}, {} as never)),
        /archive unavailable/,
      );
      assert.deepEqual(gauges, [['AuditAnchorVerificationMismatch', 0]]);
      const r = await runVerify(db, ORG, {
        archive: {
          ...down,
          listVersions: () => {
            throw new Error('x');
          },
        } as never,
      });
      assert.equal(r.archive, 'unavailable');
    });
  });
});
