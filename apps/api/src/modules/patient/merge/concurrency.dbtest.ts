// Real-database tests for BE-09, part 2: real concurrency on two connections (ARCHITECTURE 25.2, 38.2 item 1; SHARED-BOUNDARIES 9.2;
// TC-MG-08/09 as far as the modules built so far allow) and the time bound (TC-MG-14). The booking-confirm-versus-merge race is not
// asserted here: no scheduling occupancy exists yet (BE-11, INT-02). The same ordering is exercised on patient rows: a writer that
// holds the patient roots (lock_patients, the guard) and writes rows for both patients, against a merge that locks them.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/merge/concurrency.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KernelDb, ParticipantRegistries } from '@ehr/kernel';
import type { MergeParticipant } from '@ehr/kernel';
import { ORG, pg, registerCombinedParticipants, saWrite, setupMerge } from './testkit.js';
import type { Client, MergeKit } from './testkit.js';

let m: MergeKit;
before(
  async () => {
    m = await setupMerge('mgc');
  },
  { timeout: 120_000 },
);
after(
  async () => {
    await m?.close();
  },
  { timeout: 60_000 },
);

const q = <T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]> =>
  m.k.q<T>(sql, p);
const n = async (sql: string, p?: unknown[]): Promise<number> =>
  Number(((await q<{ n: string }>(sql, p))[0] as { n: string }).n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let next = 500;
const patient = (): Promise<string> => m.mkPatient(next++);
const approved = async (S: string, D: string): Promise<string> => {
  const rid = (await m.request(m.lead, S, D)).json()['id'] as string;
  assert.equal((await m.approve(m.mr, rid)).status, 200);
  return rid;
};
const status = async (p: string): Promise<string> =>
  (
    (await q<{ status: string }>(`SELECT status FROM patient.patient WHERE id = $1`, [p]))[0] as {
      status: string;
    }
  ).status;
const contactSql = `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES (gen_random_uuid(), $1, $2, 'emergency', $3)`;

/** An open transaction of a writer: a system job scoped to exactly these patients, on a second connection. */
async function writer(ids: string[]): Promise<Client> {
  const c = await m.newClient();
  await c.query('BEGIN');
  await c.query(
    `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true), set_config('app.realm', 'worker', true),
            set_config('app.job_scope', 'patients', true), set_config('app.job_patient_ids', $2, true)`,
    [ORG, ids.join(',')],
  );
  return c;
}

/** Waits until a backend running a statement that contains `text` is waiting for a lock. */
async function blockedOn(text: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await q(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`,
      [`%${text}%`],
    );
    if (r.length > 0) return;
    await sleep(25);
  }
  throw new Error(`nothing was waiting on a lock in a statement containing ${text}`);
}

const holdParticipant = (): {
  p: MergeParticipant;
  entered: Promise<void>;
  release: () => void;
} => {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const enteredP = new Promise<void>((r) => (entered = r));
  return {
    entered: enteredP,
    release: () => release(),
    p: {
      module: 'hold',
      tables: ['hold.item'],
      conflictRules: [],
      repointPatient: async () => {
        entered();
        await gate;
        return [{ table: 'hold.item', found: 0, repointed: 0, resolved: 0, kept: 0, deleted: [] }];
      },
    },
  };
};

const registries = (...extra: MergeParticipant[]): ParticipantRegistries => {
  const r = new ParticipantRegistries();
  registerCombinedParticipants(r);
  for (const p of extra) r.registerMergeParticipant(p);
  return r;
};

describe(
  'a merge against writers that hold the patients (25.2, 38.2 item 1; TC-MG-09 on patient rows)',
  { timeout: 60_000 },
  () => {
    test('writer first: a transaction writing rows for BOTH patients commits first, the merge waits for it, then counts and re-points both rows', async () => {
      const S = await patient();
      const D = await patient();
      const rid = await approved(S, D);
      const w = await writer([S, D]);
      await w.query(`SELECT patient.lock_patients($1::uuid[], 'key_share')`, [[S, D]]); // 25.2 rule 1: all roots at the start
      await w.query(contactSql, [ORG, D, 'written by the writer for the merged patient']);
      await w.query(contactSql, [ORG, S, 'written by the writer for the survivor']);
      let finished = false;
      const merge = m.run(rid).then((r) => ((finished = true), r));
      await blockedOn('begin_merge'); // the merge waits on the roots the writer holds
      await sleep(200);
      assert.equal(finished, false, 'the merge must wait for the writer');
      await w.query('COMMIT');
      await w.end();
      const res = await merge;
      assert.equal(res.status, 'completed', JSON.stringify(res));
      const counts = (
        (
          await q<{ counts: Record<string, Record<string, number>> }>(
            `SELECT counts FROM patient.merge_request WHERE id = $1`,
            [rid],
          )
        )[0] as { counts: Record<string, Record<string, number>> }
      ).counts;
      assert.equal(
        counts['patient.patient_contact']?.['found'],
        1,
        "the writer's row for the merged patient was found",
      );
      assert.equal(counts['patient.patient_contact']?.['repointed'], 1);
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [S]),
        2,
      );
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
        0,
      );
    });

    test('merge first: the merge holds the roots, a later writer waits and is then refused for the merged ID (patient.merged) but may write the survivor', async () => {
      const S = await patient();
      const D = await patient();
      const rid = await approved(S, D);
      const hold = holdParticipant();
      const merge = m.run(rid, { registries: registries(hold.p) });
      await hold.entered; // begin_merge has run: the roots are locked FOR UPDATE
      const w = await writer([S, D]);
      const lock = w.query(`SELECT patient.lock_patients($1::uuid[], 'key_share')`, [[S, D]]);
      await blockedOn('lock_patients');
      hold.release();
      const res = await merge;
      assert.equal(res.status, 'completed', JSON.stringify(res));
      await lock; // the writer proceeds once the merge has committed (READ COMMITTED re-reads the root)
      await w.query(contactSql, [ORG, S, 'survivor write after the merge']); // allowed
      await assert.rejects(
        w.query(contactSql, [ORG, D, 'merged write after the merge']),
        (e: { code?: string }) => e.code === 'PM001',
      );
      await w.query('ROLLBACK');
      await w.end();
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
        0,
      );
      assert.equal(
        await n(
          `SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1 AND name LIKE '%after the merge'`,
          [S],
        ),
        0,
      );
      assert.equal(await status(D), 'merged');
    });

    test("a writer that inserts a row WITHOUT locking first is still serialised by the guard's KEY SHARE: no orphan on the merged ID", async () => {
      const S = await patient();
      const D = await patient();
      const rid = await approved(S, D);
      const hold = holdParticipant();
      const merge = m.run(rid, { registries: registries(hold.p) });
      await hold.entered;
      const w = await writer([S, D]);
      const insert = w.query(contactSql, [ORG, D, 'unlocked writer']).then(
        () => 'inserted',
        (e: { code?: string }) => e.code,
      );
      await blockedOn('INSERT INTO patient.patient_contact');
      hold.release();
      assert.equal((await merge).status, 'completed');
      assert.equal(await insert, 'PM001');
      await w.query('ROLLBACK');
      await w.end();
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
        0,
      );
    });

    test('a lock upgrade (a writer that takes KEY SHARE first, then asks for NO KEY UPDATE while the merge waits) is a deadlock the database breaks: one side retries whole, nothing partial', async () => {
      const S = await patient();
      const D = await patient();
      await saWrite(m.k, contactSql, [ORG, D, 'seed']);
      const rid = await approved(S, D);
      const w = await writer([S, D]);
      await w.query(`SELECT patient.lock_patients($1::uuid[], 'key_share')`, [[S, D]]);
      await w.query(contactSql, [ORG, D, 'writer row']);
      const merge = m.run(rid, {}, 1, 3).then(
        (r) => ({ ok: true as const, r }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
      await blockedOn('begin_merge');
      // the upgrade the rule forbids: it conflicts with the merge's NO KEY UPDATE while the merge waits for the writer's KEY SHARE
      const upgrade = w
        .query(
          `SELECT id FROM patient.patient WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
          [[S, D]],
        )
        .then(
          () => ({ ok: true as const }),
          (e: { code?: string }) => ({ ok: false as const, code: e.code }),
        );
      const [mergeOut, upgradeOut] = await Promise.all([merge, upgrade]);
      // PostgreSQL aborts exactly one of them with 40P01
      assert.equal(
        [mergeOut.ok, upgradeOut.ok].filter((x) => !x).length,
        1,
        JSON.stringify([mergeOut, upgradeOut]),
      );
      if (!upgradeOut.ok) {
        assert.equal(upgradeOut.code, '40P01');
        await w.query('ROLLBACK');
        assert.equal(mergeOut.ok && mergeOut.r.status, 'completed');
      } else {
        assert.equal((mergeOut as { code?: string }).code, '40P01');
        await w.query('COMMIT'); // the writer's whole transaction stands
        const again = await m.run(rid, {}, 2, 3); // a whole new transaction
        assert.equal(again.status, 'completed', JSON.stringify(again));
      }
      await w.end();
      assert.equal(await status(D), 'merged');
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
        0,
      );
      assert.equal(
        (
          await q<{ status: string }>(`SELECT status FROM patient.merge_request WHERE id = $1`, [
            rid,
          ])
        )[0]?.status,
        'completed',
      );
    });

    test('two merges of different pairs at the same moment both complete; two merges that share a patient never deadlock', async () => {
      const [A, B, C, D2, E, F] = [
        await patient(),
        await patient(),
        await patient(),
        await patient(),
        await patient(),
        await patient(),
      ];
      const r1 = await approved(B, A);
      const r2 = await approved(D2, C);
      const [x, y] = await Promise.all([m.run(r1), m.run(r2)]);
      assert.equal(x.status, 'completed');
      assert.equal(y.status, 'completed');
      // E<-F and F<-E requested the same moment: the second request names a merged or pending patient
      const a = await m.request(m.lead, E, F);
      const b = await m.request(m.lead, F, E);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200); // different merged patients, so both may be open
      await m.approve(m.mr, a.json()['id'] as string);
      await m.approve(m.mr2, b.json()['id'] as string);
      const outs = await Promise.all([
        m.run(a.json()['id'] as string, {}, 1, 3),
        m.run(b.json()['id'] as string, {}, 1, 3),
      ]);
      const done = outs.filter((o) => o.status === 'completed');
      const failed = outs.filter((o) => o.status === 'failed');
      assert.equal(done.length, 1, JSON.stringify(outs));
      assert.equal(failed.length, 1);
      assert.deepEqual(failed[0], { status: 'failed', code: 'patient.already_merged' });
    });
  },
);

describe(
  'the time bound (TC-MG-14, 25.4: 60 s, then a complete rollback)',
  { timeout: 180_000 },
  () => {
    test('a chart ten times the sizing assumption merges inside the bound with counts that add up (timing recorded)', async () => {
      const S = await patient();
      const D = await patient();
      // No per-patient figure exists for the tables built so far (ARCHITECTURE 35.3 gives system totals). Assumption recorded in the README:
      // 5,000 notifications and 500 contacts as the largest expected chart, ten times that here.
      await saWrite(
        m.k,
        `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, status, dedupe_key)
       SELECT gen_random_uuid(), $1, 'patient', $2, 'appointment_cancelled', 2, 'sms', 'queued', 'load:' || g FROM generate_series(1, 50000) g`,
        [ORG, D],
      );
      await saWrite(
        m.k,
        `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) SELECT gen_random_uuid(), $1, $2, 'emergency', 'Load ' || g FROM generate_series(1, 5000) g`,
        [ORG, D],
      );
      const rid = await approved(S, D);
      const t0 = Date.now();
      const res = await m.run(rid);
      const ms = Date.now() - t0;
      console.log(`TC-MG-14: merge of 50,000 notifications + 5,000 contacts took ${ms} ms`);
      assert.equal(res.status, 'completed', JSON.stringify(res));
      assert.ok(ms < 60_000);
      const c = (res as { counts: Record<string, Record<string, number>> }).counts;
      assert.deepEqual(c['notifications.notification'], {
        found: 50000,
        repointed: 50000,
        resolved: 0,
        kept: 0,
      });
      assert.deepEqual(c['patient.patient_contact'], {
        found: 5000,
        repointed: 5000,
        resolved: 0,
        kept: 0,
      });
    });

    test('a merge that exceeds the transaction bound rolls back completely and is reported (the session-ending timeout is retried whole, then recorded as failed)', async () => {
      const S = await patient();
      const D = await patient();
      await saWrite(m.k, contactSql, [ORG, D, 'before the timeout']);
      const slow: MergeParticipant = {
        module: 'slow',
        tables: ['slow.item'],
        conflictRules: [],
        repointPatient: async (tx) => {
          await tx.query(`SELECT pg_sleep(2)`);
          return [];
        },
      };
      const rid = await approved(S, D);
      const alerts = m.failures.length;
      // The bound of the worker (60 s in production) is lowered for this throwaway database only: a role-wide ALTER ROLE is
      // cluster-wide and would cut the sessions of every other test database running at the same time.
      // A fresh pool picks it up at connect time.
      const dbName = (
        (await q<{ d: string }>(`SELECT current_database() AS d`))[0] as { d: string }
      ).d;
      const dbIdent = `"${dbName.replace(/"/g, '""')}"`;
      await m.k.sa.query(
        `ALTER ROLE app_worker IN DATABASE ${dbIdent} SET transaction_timeout = '700ms'`,
      );
      // One pool per attempt, as a queue runner replaces a worker whose session the server ended.
      const attempt = async <T>(fn: (db: KernelDb) => Promise<T>): Promise<T> => {
        const pool = new pg.Pool({ connectionString: m.k.urlFor('app_worker'), max: 2 });
        pool.on('error', () => undefined);
        // as the worker's createPool does: a session ended by the server must not crash the process
        pool.on('connect', (c: { on(e: string, cb: () => void): void }) =>
          c.on('error', () => undefined),
        );
        try {
          return await fn(new KernelDb(pool as never));
        } finally {
          await pool.end().catch(() => undefined);
        }
      };
      try {
        // attempt 1 of 2: the timeout is transient, so it is rethrown for the queue's retry; the request is untouched
        await assert.rejects(
          attempt((db) => m.run(rid, { db, registries: registries(slow) }, 1, 2)),
          (e: Error & { code?: string }) =>
            e.code === '25P04' || /connection terminated/i.test(e.message),
        );
        assert.equal(
          (
            await q<{ status: string }>(`SELECT status FROM patient.merge_request WHERE id = $1`, [
              rid,
            ])
          )[0]?.status,
          'approved',
        );
        // the last attempt records the failure and raises the alert
        const res = await attempt((db) => m.run(rid, { db, registries: registries(slow) }, 2, 2));
        assert.deepEqual(res, { status: 'failed', code: 'patient.merge_failed' });
        assert.equal(m.failures.length, alerts + 1);
      } finally {
        await m.k.sa.query(
          `ALTER ROLE app_worker IN DATABASE ${dbIdent} RESET transaction_timeout`,
        );
      }
      assert.equal(await status(D), 'active');
      assert.equal(
        await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
        1,
      );
    });
  },
);
