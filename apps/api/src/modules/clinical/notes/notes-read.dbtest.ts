// Real-database tests for the notes read routes of decision HEAAA-286 (draft 8.3, 38.2 items 26-30): the co-sign queue, my notes, and
// GET /notes/{id}, on PostgreSQL 17 with the seeded roles, RLS, the identity guard and a real HTTP server. Synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/clinical/notes/notes-read.dbtest.js
// The URL names a superuser on a throwaway server. Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { A1, A2, CURSOR_KEY, adminUrl, setupNotes, staffMember } from './testkit.js';
import type { NotesKit, PatientKit, SeededSession } from './testkit.js';
import { decodeCursor, encodeCursor, filterKey } from './cursor.js';
import { NoteNotAssignedError } from './errors.js';

let t: NotesKit;
let seed = 700;
const n = (): number => ++seed;

const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
  t.k.q<T>(sql, p);
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> => {
  const r = (await rows<T>(sql, p))[0];
  assert.ok(r !== undefined, `no row for ${sql}`);
  return r;
};
const ifm = (v: unknown): Record<string, string> => ({ 'if-match': `W/"${String(v)}"` });
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const errPath = (r: { json(): Record<string, unknown> }): unknown =>
  (r.json()['errors'] as { path: string }[] | undefined)?.[0]?.path;
type Doc = Record<string, unknown>;

/** Runs `fn` and returns the SQL text of every statement any transaction opened through the API's `withScope` ran meanwhile. */
const traced = async <T>(fn: () => Promise<T>): Promise<{ res: T; sql: string[] }> => {
  const db = t.k.db as unknown as { withScope: (...a: never[]) => unknown };
  const orig = db.withScope as (...a: unknown[]) => unknown;
  const sql: string[] = [];
  db.withScope = ((scope: unknown, body: (tx: object) => unknown, ...rest: unknown[]) =>
    orig.call(
      t.k.db,
      scope,
      (tx: Record<string, unknown>) =>
        body(
          new Proxy(tx, {
            get: (target, prop) => {
              if (prop === 'query')
                return (...a: unknown[]) => {
                  sql.push(typeof a[0] === 'string' ? a[0] : JSON.stringify(a[0]));
                  return (target['query'] as (...x: unknown[]) => unknown)(...a);
                };
              const v = Reflect.get(target, prop);
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
            },
          }),
        ),
      ...rest,
    )) as never;
  try {
    return { res: await fn(), sql };
  } finally {
    db.withScope = orig as never;
  }
};

describe('notes read routes (HEAAA-286, draft 8.3) on PostgreSQL 17', () => {
  let doctor: SeededSession;
  const consultAs = async (
    by: SeededSession = doctor,
  ): Promise<{ p: PatientKit; reservationId: string; encounterId: string }> => {
    const p = await t.mkPatient(n());
    return { p, ...(await t.consult(p, by)) };
  };
  const draft = async (encounterId: string, by: SeededSession = doctor): Promise<Doc> => {
    const r = await t.scall(by, 'POST', `/api/v1/encounters/${encounterId}/notes`, {});
    assert.equal(r.status, 201, r.body);
    return r.json();
  };
  const submit = async (d: Doc, by: SeededSession): Promise<Doc> => {
    const r = await t.scall(
      by,
      'POST',
      `/api/v1/notes/${String(d['id'])}/sign`,
      undefined,
      ifm(d['version']),
    );
    assert.equal(r.status, 200, r.body);
    return r.json();
  };
  /** A trainee note waiting for the supervisor's co-signature. */
  const pending = async (): Promise<{ p: PatientKit; note: Doc }> => {
    const c = await consultAs(t.trainee);
    const d = await draft(c.encounterId, t.trainee);
    return { p: c.p, note: await submit(d, t.trainee) };
  };
  const get = (s: SeededSession, path: string) => t.scall(s, 'GET', path);
  const events = (noteId: string, actor: SeededSession) =>
    rows<{
      action: string;
      change: Doc | null;
      btg_grant_id: string | null;
      denial_reason: string | null;
    }>(
      `SELECT action, change, btg_grant_id, denial_reason FROM audit.event
        WHERE resource_type = 'clinical.note' AND resource_id = $1 AND actor_principal_id = $2 ORDER BY occurred_at`,
      [noteId, actor.seeded.principalId],
    );

  before(async () => {
    assert.ok(adminUrl, 'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server');
    t = await setupNotes('be290n');
    doctor = t.doctor;
  });
  after(async () => {
    t.clock.at = undefined;
    await t?.close();
  });

  // ===== item 6: the co-sign queue ======================================================================================
  describe('GET /clinicians/{id}/cosign-queue (38.2 item 26)', () => {
    test('lists the trainee note for the named supervisor only, oldest first; another doctor with the permission sees nothing', async () => {
      const a = await pending();
      const b = await pending();
      const sup = t.supervisor.seeded.principalId;
      const r = await get(t.supervisor, `/api/v1/clinicians/${sup}/cosign-queue`);
      assert.equal(r.status, 200, r.body);
      const items = r.json()['items'] as Doc[];
      const ids = items.map((x) => x['noteId']);
      assert.deepEqual(
        ids.filter((i) => i === a.note['id'] || i === b.note['id']),
        [a.note['id'], b.note['id']],
        'ordered by submitted_for_cosign_at, id',
      );
      const first = items.find((x) => x['noteId'] === a.note['id']) as Doc;
      assert.equal(first['status'], 'pending_cosign');
      assert.equal(first['authorPrincipalId'], t.trainee.seeded.principalId);
      assert.equal(typeof first['authorDisplayName'], 'string');
      assert.equal(first['body'], undefined, 'no body in a list item');
      assert.deepEqual(
        Object.keys(first['patientBanner'] as Doc).sort(),
        ['dateOfBirth', 'displayName', 'mrn', 'patientId'],
        'no photo and no contact',
      );
      assert.equal(r.json()['nextCursor'], null);

      const d2 = t.doctor2.seeded.principalId;
      const other = await get(t.doctor2, `/api/v1/clinicians/${d2}/cosign-queue`);
      assert.equal(other.status, 200, 'doctor2 holds clinical.note.cosign');
      assert.deepEqual(other.json()['items'], [], 'nothing is waiting for doctor2');
    });

    test('another {id} is 403 auth.forbidden before any clinical query and with no service call; a denied audit row is written; a non-UUID {id} is 404', async () => {
      const reads = t.notes.reads as unknown as Record<string, (...a: unknown[]) => unknown>;
      const origQueue = reads['cosignQueue'] as (...a: unknown[]) => unknown;
      let serviceCalls = 0;
      reads['cosignQueue'] = (...a: unknown[]) => {
        serviceCalls += 1;
        return origQueue.apply(t.notes.reads, a);
      };
      const sup = t.supervisor.seeded.principalId;
      try {
        const known = await traced(() => get(t.doctor2, `/api/v1/clinicians/${sup}/cosign-queue`));
        const unknown = await traced(() =>
          get(t.doctor2, `/api/v1/clinicians/${randomUUID()}/cosign-queue`),
        );
        for (const x of [known, unknown]) {
          assert.equal(x.res.status, 403, x.res.body);
          assert.equal(code(x.res), 'auth.forbidden');
          assert.equal(
            x.sql.some((q) => /clinical\./.test(q)),
            false,
            'no clinical query before the refusal (the guard and the denial audit write only)',
          );
        }
        const strip = (b: string): string => b.replace(/"requestId":"[^"]*"/, '');
        assert.equal(
          strip(known.res.body),
          strip(unknown.res.body),
          'the body is identical for every {id}',
        );
        assert.equal(serviceCalls, 0, 'the service was not called');
        const own = await traced(() =>
          get(t.doctor2, `/api/v1/clinicians/${t.doctor2.seeded.principalId}/cosign-queue`),
        );
        assert.equal(own.res.status, 200);
        assert.equal(serviceCalls, 1);
        assert.ok(
          own.sql.some((q) => /clinical\.note/.test(q)),
          'the allowed path queries',
        );
      } finally {
        reads['cosignQueue'] = origQueue;
      }
      const den = await one<{ c: string }>(
        `SELECT count(*)::text AS c FROM audit.event WHERE action = 'denied' AND resource_type = 'clinical.note'
            AND actor_principal_id = $1 AND denial_reason = 'forbidden'`,
        [t.doctor2.seeded.principalId],
      );
      assert.ok(Number(den.c) >= 2);
      const nonUuid = await get(t.supervisor, '/api/v1/clinicians/not-a-uuid/cosign-queue');
      assert.equal(nonUuid.status, 404);
    });

    test('cursors: forged, issued to another principal, from /notes, with another status filter, and expired are all kernel.validation_failed on /cursor', async () => {
      await pending();
      await pending();
      const sup = t.supervisor.seeded.principalId;
      const path = `/api/v1/clinicians/${sup}/cosign-queue`;
      const page1 = await get(t.supervisor, `${path}?limit=1`);
      assert.equal(page1.status, 200, page1.body);
      const cur = page1.json()['nextCursor'] as string;
      assert.ok(cur, 'a second page exists');
      const page2 = await get(t.supervisor, `${path}?limit=1&cursor=${encodeURIComponent(cur)}`);
      assert.equal(page2.status, 200, page2.body);
      assert.notEqual(
        (page2.json()['items'] as Doc[])[0]?.['noteId'],
        (page1.json()['items'] as Doc[])[0]?.['noteId'],
      );
      const expectBad = async (
        s: SeededSession,
        p: string,
        c: string,
        why: string,
      ): Promise<void> => {
        const r = await get(s, `${p}?limit=1&cursor=${encodeURIComponent(c)}`);
        assert.equal(r.status === 400 || r.status === 422, true, `${why}: ${r.status} ${r.body}`);
        assert.equal(code(r), 'kernel.validation_failed', why);
        assert.equal(errPath(r), '/cursor', why);
      };
      const [body] = cur.split('.');
      await expectBad(t.supervisor, path, `${body}.AAAA`, 'forged mac');
      await expectBad(t.supervisor, path, 'garbage', 'malformed');
      const at = { k: '2031-01-01T00:00:00.000000Z', i: randomUUID() };
      const bind = (principalId: string, route: 'notes' | 'cosign-queue', filter: string) => ({
        principalId,
        route,
        filter,
      });
      await expectBad(
        t.supervisor,
        path,
        encodeCursor(
          CURSOR_KEY,
          new Date(),
          bind(t.doctor2.seeded.principalId, 'cosign-queue', ''),
          at,
        ),
        'issued to another principal',
      );
      await expectBad(
        t.supervisor,
        path,
        encodeCursor(
          CURSOR_KEY,
          new Date(),
          bind(sup, 'notes', filterKey(['draft', 'pending_cosign'])),
          at,
        ),
        'from /notes',
      );
      await expectBad(
        t.supervisor,
        path,
        encodeCursor(CURSOR_KEY, new Date(), bind(sup, 'cosign-queue', 'draft'), at),
        'another filter',
      );
      // expired: issued now, used 16 minutes later on the injected clock
      t.clock.at = new Date(Date.now() + 16 * 60_000);
      try {
        await expectBad(t.supervisor, path, cur, 'expired');
      } finally {
        t.clock.at = undefined;
      }
      assert.deepEqual(
        decodeCursor(CURSOR_KEY, new Date(), bind(sup, 'cosign-queue', ''), cur).i.length,
        36,
      );
    });

    test('item 30: the queue query uses note_cosign_queue_idx', async () => {
      await pending();
      const plan = await t.k.sa.query(`SET enable_seqscan = off;`);
      void plan;
      const r = await t.k.sa.query(
        `EXPLAIN SELECT n.id FROM clinical.note n
          WHERE n.status = 'pending_cosign' AND n.cosign_required_from = $1::uuid
          ORDER BY n.submitted_for_cosign_at ASC, n.id ASC LIMIT 26`,
        [t.supervisor.seeded.principalId],
      );
      await t.k.sa.query(`RESET enable_seqscan`);
      const text = (r.rows as Record<string, string>[]).map((x) => x['QUERY PLAN']).join('\n');
      assert.match(text, /note_cosign_queue_idx/);
    });
  });

  // ===== item 7: my notes ===============================================================================================
  describe('GET /clinicians/{id}/notes (38.2 item 27)', () => {
    test('the author drafts and pending notes only; signed and any other status value are refused', async () => {
      const me = t.doctor2;
      const mine = me.seeded.principalId;
      const c1 = await consultAs(me);
      const d1 = await draft(c1.encounterId, me);
      const c2 = await consultAs(me);
      const d2 = await draft(c2.encounterId, me);
      const signed = await t.scall(
        me,
        'POST',
        `/api/v1/notes/${String(d2['id'])}/sign`,
        undefined,
        ifm(d2['version']),
      );
      assert.equal(signed.status, 200, signed.body);
      const r = await get(me, `/api/v1/clinicians/${mine}/notes`);
      assert.equal(r.status, 200, r.body);
      const ids = (r.json()['items'] as Doc[]).map((x) => x['noteId']);
      assert.ok(ids.includes(d1['id']));
      assert.ok(!ids.includes(d2['id']), 'a signed note is not listed');
      for (const bad of ['signed', 'bogus']) {
        const x = await get(me, `/api/v1/clinicians/${mine}/notes?status=${bad}`);
        assert.equal(code(x), 'kernel.validation_failed', bad);
      }
      const pend = await get(me, `/api/v1/clinicians/${mine}/notes?status=pending_cosign`);
      assert.equal(pend.status, 200);
      assert.ok(!(pend.json()['items'] as Doc[]).some((x) => x['noteId'] === d1['id']));
      const other = await get(t.supervisor, `/api/v1/clinicians/${mine}/notes`);
      assert.equal(other.status, 403);
    });

    test('order is COALESCE(updated_at, created_at) DESC, id DESC; paging by 1 over five notes (two with equal keys) returns each exactly once', async () => {
      const me = await staffMember(t.k, 'doctor', A1, 'Doctor ordering');
      const mine = me.seeded.principalId;
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const c = await consultAs(me);
        ids.push(String((await draft(c.encounterId, me))['id']));
      }
      // never-edited drafts have a null updated_at: place the five keys explicitly (superuser, triggers off)
      const keys = [
        ['2031-03-01T10:00:00.000000Z', null], // never edited, newest
        ['2031-01-01T10:00:00.000000Z', '2031-02-01T10:00:00.000000Z'], // edited: 02-01
        ['2031-01-05T10:00:00.000000Z', null], // never edited, older than the edited one (01-05)
        ['2031-01-01T00:00:00.000000Z', '2031-01-15T09:00:00.000000Z'], // tie A: 01-15 09:00
        ['2031-01-15T09:00:00.000000Z', null], // tie B: equal key 01-15 09:00
      ] as const;
      await t.k.sa.query(`SET session_replication_role = replica`);
      try {
        for (const [i, [c, u]] of keys.entries())
          await t.k.sa.query(
            `UPDATE clinical.note SET created_at = $2::timestamptz, updated_at = $3::timestamptz WHERE id = $1`,
            [ids[i], c, u],
          );
      } finally {
        await t.k.sa.query(`SET session_replication_role = DEFAULT`);
      }
      const expected = [ids[0], ids[1], ...[ids[3], ids[4]].sort().reverse(), ids[2]];
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const r = await get(
          me,
          `/api/v1/clinicians/${mine}/notes?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        assert.equal(r.status, 200, r.body);
        for (const x of r.json()['items'] as Doc[]) seen.push(String(x['noteId']));
        cursor = r.json()['nextCursor'] as string | null;
        if (cursor === null) break;
      }
      assert.deepEqual(seen, expected, 'each note exactly once, in the specified order');
      // cursor binding: a notes cursor does not open the other filter or the queue
      const first = await get(me, `/api/v1/clinicians/${mine}/notes?limit=1`);
      const cur = first.json()['nextCursor'] as string;
      const wrongFilter = await get(
        me,
        `/api/v1/clinicians/${mine}/notes?limit=1&status=draft&cursor=${encodeURIComponent(cur)}`,
      );
      assert.equal(code(wrongFilter), 'kernel.validation_failed');
      assert.equal(errPath(wrongFilter), '/cursor');
      const asQueue = await get(
        me,
        `/api/v1/clinicians/${mine}/cosign-queue?cursor=${encodeURIComponent(cur)}`,
      );
      assert.equal(errPath(asQueue), '/cursor');
    });
  });

  // ===== item 8: GET /notes/{id} ========================================================================================
  describe('GET /notes/{id} (38.2 item 28)', () => {
    test('(a) author: 200 with ETag and basis author; (j) exactly one read event', async () => {
      const c = await consultAs();
      const d = await draft(c.encounterId);
      const id = String(d['id']);
      const r = await get(doctor, `/api/v1/notes/${id}`);
      assert.equal(r.status, 200, r.body);
      assert.equal(r.headers['etag'], `W/"${String(d['version'])}"`);
      const note = r.json();
      assert.equal(note['id'], id);
      assert.equal(note['rowVersion'], d['version']);
      assert.equal(typeof note['timeZone'], 'string');
      assert.deepEqual(note['addenda'], []);
      assert.equal(note['cosign'], null);
      const banner = note['patientBanner'] as Doc;
      assert.ok(
        banner && banner['photoUrl'] === undefined && banner['photoDocumentId'] === undefined,
      );
      const ev = (await events(id, doctor)).filter((e) => e.action === 'view');
      assert.equal(ev.length, 1);
      assert.deepEqual(ev[0]?.change, { basis: 'author' });
    });

    test('(b)(c)(d)(e) supervisor: pending from the caller yes; a draft no; after cosign_required_from changes no; after co-signing yes', async () => {
      const { note } = await pending();
      const id = String(note['id']);
      const ok = await get(t.supervisor, `/api/v1/notes/${id}`);
      assert.equal(ok.status, 200, ok.body);
      const banner = ok.json()['patientBanner'] as Doc;
      assert.equal(banner['photoUrl'], undefined);
      assert.equal(banner['photoDocumentId'], undefined);
      assert.equal(banner['contacts'], undefined);
      assert.deepEqual(
        (await events(id, t.supervisor)).filter((e) => e.action === 'view').map((e) => e.change),
        [{ basis: 'supervisor' }],
      );

      // (c) the same supervisor on a draft
      const c = await consultAs(t.trainee);
      const dr = await draft(c.encounterId, t.trainee);
      const refused = await get(t.supervisor, `/api/v1/notes/${String(dr['id'])}`);
      assert.equal(refused.status, 403, refused.body);
      assert.equal(code(refused), 'clinical.not_assigned');
      const den = await events(String(dr['id']), t.supervisor);
      assert.equal(den.filter((e) => e.action === 'denied').length, 1);
      assert.equal(den.filter((e) => e.action === 'view').length, 0);

      // (d) cosign_required_from changes to another principal
      await t.k.sa.query(`SET session_replication_role = replica`);
      try {
        await t.k.sa.query(`UPDATE clinical.note SET cosign_required_from = $2 WHERE id = $1`, [
          id,
          t.doctor2.seeded.principalId,
        ]);
      } finally {
        await t.k.sa.query(`SET session_replication_role = DEFAULT`);
      }
      assert.equal((await get(t.supervisor, `/api/v1/notes/${id}`)).status, 403);
      await t.k.sa.query(`SET session_replication_role = replica`);
      try {
        await t.k.sa.query(`UPDATE clinical.note SET cosign_required_from = $2 WHERE id = $1`, [
          id,
          t.supervisor.seeded.principalId,
        ]);
      } finally {
        await t.k.sa.query(`SET session_replication_role = DEFAULT`);
      }

      // (e) after co-signing
      const cs = await t.scall(t.supervisor, 'POST', `/api/v1/notes/${id}/cosign`, {});
      assert.equal(cs.status, 200, cs.body);
      const after = await get(t.supervisor, `/api/v1/notes/${id}`);
      assert.equal(after.status, 200, after.body);
      assert.equal(
        (after.json()['cosign'] as Doc)['supervisorPrincipalId'],
        t.supervisor.seeded.principalId,
      );
      const last = (await events(id, t.supervisor)).filter((e) => e.action === 'view').pop();
      assert.deepEqual(last?.change, { basis: 'supervisor' });
    });

    test('(f)(g)(h) unassigned doctor: 403, then BTG gives 200 with basis btg, the grant on the read row and the compliance alert queued; an assigned doctor reads with basis assigned; the trainee error carries btgAvailable false', async () => {
      const c = await consultAs();
      const d = await draft(c.encounterId);
      const id = String(d['id']);
      const reads = t.notes.reads as unknown as { get: (...a: unknown[]) => Promise<unknown> };
      const origGet = reads.get.bind(t.notes.reads);
      const thrown: unknown[] = [];
      reads.get = async (...a: unknown[]) => {
        try {
          return await origGet(...a);
        } catch (e) {
          thrown.push(e);
          throw e;
        }
      };
      try {
        // (f) an unassigned doctor
        const no = await get(t.doctor2, `/api/v1/notes/${id}`);
        assert.equal(no.status, 403, no.body);
        assert.equal(code(no), 'clinical.not_assigned');
        assert.equal(no.json()['btgAvailable'], true, 'the member is on the wire (QA-EXEC-F01)');
        const e1 = thrown.pop();
        assert.ok(e1 instanceof NoteNotAssignedError);
        assert.equal(e1.btgAvailable, true);
        const den = (await events(id, t.doctor2)).filter((e) => e.action === 'denied');
        assert.equal(den.length, 1);
        assert.equal(den[0]?.denial_reason, 'forbidden');

        // (h) the unassigned trainee
        const tr = await get(t.trainee, `/api/v1/notes/${id}`);
        assert.equal(tr.status, 403, tr.body);
        assert.equal(code(tr), 'clinical.not_assigned');
        assert.equal(tr.json()['btgAvailable'], false);
        const e2 = thrown.pop();
        assert.ok(e2 instanceof NoteNotAssignedError);
        assert.equal(e2.btgAvailable, false, 'the trainee holds no audit.btg.open');
      } finally {
        reads.get = origGet;
      }

      // BTG then 200, basis btg, grant on the read row
      const grant = await t.as(t.staffScope(t.doctor2), (tx) =>
        t.k.audit.openBtg(tx, {
          requestId: randomUUID(),
          patientId: c.p.patientId,
          reason: 'Emergency review of a synthetic note',
        }),
      );
      const ok = await get(t.doctor2, `/api/v1/notes/${id}`);
      assert.equal(ok.status, 200, ok.body);
      const reads2 = (await events(id, t.doctor2)).filter((e) => e.action === 'view');
      assert.equal(reads2.length, 1);
      assert.deepEqual(reads2[0]?.change, { basis: 'btg' });
      assert.equal(reads2[0]?.btg_grant_id, grant.grantId);
      const queued = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM queue._private_jobs j JOIN queue._private_tasks k ON k.id = j.task_id WHERE k.identifier = 'sink.on_btg_opened' AND j.payload->>'grantId' = $1`,
        [grant.grantId],
      );
      assert.ok(
        Number(queued[0]?.n) >= 1,
        'the audit.btg_opened compliance event exists for the grant',
      );

      // (g) an assigned doctor: a reservation of its own for the patient
      await t.confirmed(c.p, undefined, t.supervisor);
      const asg = await get(t.supervisor, `/api/v1/notes/${id}`);
      assert.equal(asg.status, 200, asg.body);
      const sr = (await events(id, t.supervisor)).filter((e) => e.action === 'view');
      assert.deepEqual(sr.pop()?.change, { basis: 'assigned' });
    });

    test('(i) a note outside the caller location scope is 404 kernel.not_found, audited not_visible', async () => {
      const c = await consultAs();
      const d = await draft(c.encounterId);
      const id = String(d['id']);
      const far = await staffMember(t.k, 'doctor', A2, 'Doctor A2 only');
      const r = await get(far, `/api/v1/notes/${id}`);
      assert.equal(r.status, 404, r.body);
      assert.equal(code(r), 'kernel.not_found');
      const nv = await one<{ c: string }>(
        `SELECT count(*)::text AS c FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible' AND actor_principal_id = $1`,
        [far.seeded.principalId],
      );
      assert.ok(Number(nv.c) >= 1);
    });

    test('a signed note with an addendum shows the addendum and the co-signature rows of the author path', async () => {
      const c = await consultAs();
      const d = await draft(c.encounterId);
      const s = await submit(d, doctor);
      const ad = await t.scall(doctor, 'POST', `/api/v1/notes/${String(s['id'])}/addenda`, {
        body: 'SYNTHETIC addendum',
      });
      assert.equal(ad.status, 201, ad.body);
      const r = await get(doctor, `/api/v1/notes/${String(s['id'])}`);
      assert.equal(r.status, 200);
      const addenda = r.json()['addenda'] as Doc[];
      assert.equal(addenda.length, 1);
      assert.equal(addenda[0]?.['body'], 'SYNTHETIC addendum');
    });
  });

  // ===== item 9: list audit =============================================================================================
  describe('list audit (38.2 item 29)', () => {
    test('one view event per call; the patientIds count does not exceed limit', async () => {
      for (let i = 0; i < 3; i += 1) await pending();
      const sup = t.supervisor.seeded.principalId;
      const count = async (): Promise<number> =>
        Number(
          (
            await one<{ c: string }>(
              `SELECT count(*)::text AS c FROM audit.event WHERE action = 'view' AND resource_type = 'clinical.note'
                  AND resource_id IS NULL AND actor_principal_id = $1`,
              [sup],
            )
          ).c,
        );
      const before = await count();
      const r = await get(t.supervisor, `/api/v1/clinicians/${sup}/cosign-queue?limit=2`);
      assert.equal(r.status, 200, r.body);
      assert.equal((await count()) - before, 1);
      const ev = await one<{ change: { patientIds: string[] } }>(
        `SELECT change FROM audit.event WHERE action = 'view' AND resource_type = 'clinical.note' AND resource_id IS NULL
            AND actor_principal_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [sup],
      );
      assert.ok(ev.change.patientIds.length <= 2);
      assert.equal(JSON.stringify(ev.change).includes('body'), false, 'no note text in the event');
    });
  });
});
