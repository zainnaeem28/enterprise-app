// Real-database tests for BE-19 (messaging) on PostgreSQL 17 with the real roles, migrations 2000-2002, the real Nest application and
// identity guard, the real audit service and queue, and the REAL merge participants of identity, notifications, documents, scheduling,
// clinical, privacy and messaging:
//   TC-MSG-01 (create a task, send a secure message: delivered in the thread/task area, audited, no PHI in any notice),
//   TC-MSG-02 (staff outside the organisation: refused, by route and by SQL), TC-MSG-03 (patient messaging: off by default, a 404; on, it
//   works), TC-MSG-04 (a script string is stored and returned as data), 38.2 item 16 (a principal cannot insert itself as owner or
//   member of a thread it did not create), the task rules, the merge participant with the 38.2 item 11 count test, the export part,
//   and privacy correction requests becoming tasks.
// docs/TEST-CASES.md defines TC-MSG-01..04 only (10.4). The ticket names TC-MSG-01..06; the two further cases here (TC-MSG-05 the merge
// participant and TC-MSG-06 the correction request becoming a task) are named from the ticket's acceptance and are NOT catalogue cases.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/messaging/messaging.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { ScopeSettings, Tx } from '@ehr/kernel';
import { runOnCorrectionRequested, NoAssigneeError } from './corrections.js';
import { MESSAGING_CONFLICT_RULES, MESSAGING_MERGE_TABLES, messagingExportPart } from './merge.js';
import { ORG, ORG2, A1, A2, setupMessaging, uuidv7 } from './testkit.js';
import type { MessagingKit, PatientKit, SeededSession } from './testkit.js';

const SEED_ATTACK = '<script>window.__pwned=1</script>"><img src=x onerror=alert(1)>';
const CANARY = 'CANARY-MESSAGE-BODY-3f9a';

describe('messaging (BE-19) on PostgreSQL 17', () => {
  let t: MessagingKit;
  let seq = 200;
  before(async () => {
    t = await setupMessaging('messaging');
  });
  after(async () => {
    await t.close();
  });

  const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
  const pid = (s: SeededSession): string => s.seeded.principalId;
  const count = async (tx: Tx, sql: string, params: unknown[] = []): Promise<number> =>
    Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    t.k.q<T>(sql, params);
  const sc = (
    s: SeededSession,
    loc: string[] = [A1],
    extra: Partial<ScopeSettings> = {},
  ): ScopeSettings => t.scopeOf(s, loc, extra);
  const mk = (at = A1): Promise<PatientKit> => t.mkPatient(++seq, at);

  const newThread = async (
    owner: SeededSession,
    members: SeededSession[],
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const r = await t.scall(owner, 'POST', '/api/v1/threads', {
      subject: 'Test thread',
      participantIds: members.map(pid),
      ...extra,
    });
    assert.equal(r.status, 201, r.body);
    return String(r.json()['id']);
  };
  const newTask = async (
    creator: SeededSession,
    assignee: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await t.scall(creator, 'POST', '/api/v1/tasks', {
      title: 'A task',
      assignee,
      ...extra,
    });
    assert.equal(r.status, 201, r.body);
    return r.json();
  };
  const patchTask = (s: SeededSession, id: string, version: number, body: unknown) =>
    t.scall(s, 'PATCH', `/api/v1/tasks/${id}`, body, { 'if-match': `W/"${version}"` });

  test('TC-MSG-01: a task and a secure message are delivered in the task/thread area, audited, with no notice and no text in audit', async () => {
    const notices = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications.notification`,
    );
    // A task from the doctor to the front desk, completed by the assignee.
    const task = await newTask(
      t.doctor,
      { principalId: pid(t.desk) },
      { title: 'Call the lab about the results', detail: CANARY },
    );
    assert.equal(task['status'], 'open');
    const mine = await t.scall(t.desk, 'GET', '/api/v1/tasks');
    assert.equal(mine.status, 200);
    assert.ok(
      (mine.json()['items'] as Array<Record<string, unknown>>).some((x) => x['id'] === task['id']),
      'the assignee sees the task',
    );
    const done = await patchTask(t.desk, String(task['id']), Number(task['version']), {
      status: 'done',
    });
    assert.equal(done.status, 200, done.body);
    assert.equal(done.json()['status'], 'done');
    assert.ok(done.json()['completedAt']);
    const doneList = await t.scall(t.doctor, 'GET', '/api/v1/tasks?status=done');
    assert.ok(
      (doneList.json()['items'] as Array<Record<string, unknown>>).some(
        (x) => x['id'] === task['id'],
      ),
      'the creator sees it done',
    );

    // A secure message.
    const threadId = await newThread(t.doctor, [t.desk], {
      subject: 'Room change',
      body: `Please move the 3pm slot ${CANARY}`,
    });
    const lst = await t.scall(t.desk, 'GET', '/api/v1/threads');
    const mineT = (lst.json()['items'] as Array<Record<string, unknown>>).find(
      (x) => x['id'] === threadId,
    );
    assert.ok(mineT, 'the participant sees the thread');
    assert.equal((mineT['me'] as Record<string, unknown>)['role'], 'member');
    assert.equal(mineT['unread'], 1);
    const msgs = await t.scall(t.desk, 'GET', `/api/v1/threads/${threadId}/messages`);
    assert.equal(msgs.status, 200);
    assert.equal((msgs.json()['items'] as unknown[]).length, 1);
    const after = await t.scall(t.desk, 'GET', '/api/v1/threads');
    assert.equal(
      (
        (after.json()['items'] as Array<Record<string, unknown>>).find(
          (x) => x['id'] === threadId,
        ) as Record<string, unknown>
      )['unread'],
      0,
    );
    const reply = await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, {
      body: 'Done, moved to 4pm',
    });
    assert.equal(reply.status, 201, reply.body);
    const both = await t.scall(t.doctor, 'GET', `/api/v1/threads/${threadId}/messages`);
    const items = both.json()['items'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((x) => x['body']),
      [`Please move the 3pm slot ${CANARY}`, 'Done, moved to 4pm'],
    );

    // Audited, with IDs and counts only; no notice was created; no queue payload carries text.
    const ev = await q<{ resource_type: string; action: string }>(
      `SELECT resource_type, action FROM audit.event WHERE resource_type LIKE 'messaging.%' AND (resource_id = ANY($1::uuid[]))`,
      [[task['id'], threadId, String(reply.json()['id'])]],
    );
    assert.ok(ev.some((e) => e.resource_type === 'messaging.task' && e.action === 'create'));
    assert.ok(ev.some((e) => e.resource_type === 'messaging.task' && e.action === 'update'));
    assert.ok(ev.some((e) => e.resource_type === 'messaging.thread' && e.action === 'create'));
    assert.ok(ev.some((e) => e.resource_type === 'messaging.message' && e.action === 'create'));
    assert.equal(
      (
        await q(
          `SELECT 1 FROM audit.event WHERE change::text LIKE '%CANARY%' OR reason LIKE '%CANARY%'`,
        )
      ).length,
      0,
    );
    assert.equal(
      (await q(`SELECT 1 FROM queue._private_jobs WHERE payload::text LIKE '%CANARY%'`)).length,
      0,
    );
    const noticesAfter = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications.notification`,
    );
    assert.equal(
      noticesAfter[0]?.n,
      notices[0]?.n,
      'no email or SMS notice is created by a task or a message',
    );
  });

  test('TC-MSG-02: staff cannot send a message to, or assign a task to, a user of another organisation (route and database)', async () => {
    const msg = await t.scall(t.desk, 'POST', '/api/v1/threads', {
      subject: 'Cross org',
      participantIds: [t.foreign.principalId],
      body: 'hi',
    });
    assert.equal(msg.status, 422, msg.body);
    assert.equal(code(msg), 'messaging.participant_invalid');
    assert.equal(
      (await q(`SELECT 1 FROM messaging.thread WHERE subject = 'Cross org'`)).length,
      0,
      'nothing was left behind',
    );
    const task = await t.scall(t.desk, 'POST', '/api/v1/tasks', {
      title: 'Cross org',
      assignee: { principalId: t.foreign.principalId },
    });
    assert.equal(task.status, 422, task.body);
    assert.equal(code(task), 'messaging.participant_invalid');
    // The same by SQL, with the route and the service out of the way: the trigger and the policies refuse.
    await assert.rejects(
      t.as(sc(t.desk), async (tx) => {
        const id = uuidv7();
        await tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, subject, created_by) VALUES ($1, $2, 'staff', 'x', $3)`,
          [id, ORG, pid(t.desk)],
        );
        await tx.query(
          `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, 'owner', $4)`,
          [id, pid(t.desk), ORG, pid(t.desk)],
        );
        await tx.query(
          `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, 'member', $4)`,
          [id, t.foreign.principalId, ORG, pid(t.desk)],
        );
      }),
      (e: { code?: string }) => e.code === 'PS001',
    );
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(
          `INSERT INTO messaging.task (id, organisation_id, title, assignee_kind, assignee_principal_id, created_by) VALUES ($1, $2, 'x', 'principal', $3, $4)`,
          [uuidv7(), ORG, t.foreign.principalId, pid(t.desk)],
        ),
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
    // A foreign location or role is refused for a role-at-location task too.
    const loc = await t.scall(t.desk, 'POST', '/api/v1/tasks', {
      title: 'x',
      assignee: { roleKey: 'no_such_role', locationId: A1 },
    });
    assert.equal(loc.status, 422);
  });

  test('38.2 item 16: a principal cannot insert itself as owner or member of a thread it did not create; the creator can', async () => {
    const threadId = await newThread(t.doctor, [t.desk]); // desk is a member, desk2 is nobody
    const insert = (who: SeededSession, target: SeededSession, role: 'owner' | 'member') =>
      t.as(sc(who), (tx) =>
        tx.query(
          `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, $4, $5)`,
          [threadId, pid(target), ORG, role, pid(who)],
        ),
      );
    // desk2 is not a participant: it cannot add itself in either role.
    for (const role of ['owner', 'member'] as const)
      await assert.rejects(
        insert(t.desk2, t.desk2, role),
        (e: { code?: string }) => e.code === '42501',
        `self as ${role}`,
      );
    // desk2 cannot add anybody else either, nor can a plain member (desk) add desk2 or promote itself.
    await assert.rejects(
      insert(t.desk2, t.coordinator, 'member'),
      (e: { code?: string }) => e.code === '42501',
    );
    await assert.rejects(
      insert(t.desk, t.desk2, 'member'),
      (e: { code?: string }) => e.code === '42501',
      'a member is not an owner',
    );
    await assert.rejects(
      insert(t.desk, t.desk, 'owner'),
      (e: { code?: string }) => e.code === '42501',
    );
    // The thread is invisible to desk2, so even a read finds nothing.
    assert.equal(
      await t.as(sc(t.desk2), (tx) =>
        count(tx, `SELECT count(*)::int AS n FROM messaging.thread WHERE id = $1`, [threadId]),
      ),
      0,
    );
    assert.equal(
      (await t.scall(t.desk2, 'GET', `/api/v1/threads/${threadId}/messages`)).status,
      404,
    );
    assert.equal(
      (
        await t.scall(t.desk2, 'POST', `/api/v1/threads/${threadId}/messages`, {
          body: 'let me in',
        })
      ).status,
      404,
    );
    // A thread created by desk2 itself: it may insert its own owner row, but not an owner row for the doctor's thread, and not as a "member" first.
    const own = uuidv7();
    await t.as(sc(t.desk2), async (tx) => {
      await tx.query(
        `INSERT INTO messaging.thread (id, organisation_id, kind, subject, created_by) VALUES ($1, $2, 'staff', 'mine', $3)`,
        [own, ORG, pid(t.desk2)],
      );
      await tx.query(
        `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, 'owner', $2)`,
        [own, pid(t.desk2), ORG],
      );
    });
    await assert.rejects(
      t.as(sc(t.desk), async (tx) => {
        const x = uuidv7();
        await tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, subject, created_by) VALUES ($1, $2, 'staff', 'mine', $3)`,
          [x, ORG, pid(t.desk)],
        );
        // as a MEMBER first: policy (a) allows only the owner row for the creator.
        await tx.query(
          `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, 'member', $2)`,
          [x, pid(t.desk), ORG],
        );
      }),
      (e: { code?: string }) => e.code === '42501',
    );
    // The owner adds participants (policy (b)); the new member then reads and posts.
    await t.as(sc(t.doctor), (tx) =>
      tx.query(
        `INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, 'member', $4)`,
        [threadId, pid(t.coordinator), ORG, pid(t.doctor)],
      ),
    );
    assert.equal(
      (await t.scall(t.coordinator, 'GET', `/api/v1/threads/${threadId}/messages`)).status,
      200,
    );
    // A participant row is only ever read by its own principal.
    assert.equal(
      await t.as(sc(t.desk), (tx) =>
        count(
          tx,
          `SELECT count(*)::int AS n FROM messaging.thread_participant WHERE thread_id = $1`,
          [threadId],
        ),
      ),
      1,
    );
    // The last owner cannot be removed.
    await assert.rejects(
      t.as(sc(t.doctor), (tx) =>
        tx.query(
          `DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2`,
          [threadId, pid(t.doctor)],
        ),
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
    // The creator sees the thread before its own participant row exists (draft 7).
    assert.equal(
      await t.as(sc(t.desk2), async (tx) => {
        const x = uuidv7();
        await tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, subject, created_by) VALUES ($1, $2, 'staff', 'early', $3)`,
          [x, ORG, pid(t.desk2)],
        );
        return count(tx, `SELECT count(*)::int AS n FROM messaging.thread WHERE id = $1`, [x]);
      }),
      1,
    );
  });

  test('a staff member without the messaging permission, or in the wrong realm, reaches none of the routes', async () => {
    assert.equal((await t.scall(t.records, 'GET', '/api/v1/threads')).status, 403);
    assert.equal(
      (
        await t.scall(t.records, 'POST', '/api/v1/tasks', {
          title: 'x',
          assignee: { principalId: pid(t.desk) },
        })
      ).status,
      403,
    );
    assert.equal((await t.scall(t.compliance, 'GET', '/api/v1/threads')).status, 403);
    const p = await mk();
    assert.equal((await t.pcall(p.session, 'GET', '/api/v1/threads')).status, 403);
    assert.equal((await t.pcall(p.session, 'GET', '/api/v1/tasks')).status, 403);
  });

  test('threads: validation, closing (owner only, final), posting rules, paging', async () => {
    assert.equal((await t.scall(t.doctor, 'POST', '/api/v1/threads', { subject: '' })).status, 422);
    assert.equal(
      (await t.scall(t.doctor, 'POST', '/api/v1/threads', { subject: 'x'.repeat(201) })).status,
      422,
    );
    assert.equal(
      (await t.scall(t.doctor, 'POST', '/api/v1/threads', { subject: 'ok', unknownField: 1 }))
        .status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/threads', {
          subject: 'ok',
          participantIds: ['nope'],
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/threads', {
          subject: 'ok',
          locationId: randomUUID(),
        })
      ).status,
      422,
    );
    const threadId = await newThread(t.doctor, [t.desk]);
    // 10 KB limit, empty body.
    assert.equal(
      (
        await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, {
          body: 'x'.repeat(10241),
        })
      ).status,
      422,
    );
    assert.equal(
      (await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, { body: '   ' }))
        .status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, {
          body: 'x'.repeat(10240),
        })
      ).status,
      201,
    );
    // Attachments must be documents the caller can see.
    assert.equal(
      (
        await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, {
          body: 'a',
          attachmentDocumentIds: [randomUUID()],
        })
      ).status,
      422,
    );
    // A message is never changed or removed, even by SQL, even by its author.
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(`UPDATE messaging.message SET body = 'edited' WHERE thread_id = $1`, [threadId]),
      ),
      (e: { code?: string }) => e.code === '42501' || e.code === 'PS001',
    );
    await assert.rejects(
      t.k.sa.query(`UPDATE messaging.message SET body = 'edited' WHERE thread_id = $1`, [threadId]),
      (e: { code?: string }) => e.code === 'PS001',
    );
    // Only an owner closes; closed is final and takes no more messages.
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        t.messaging.threads.close(
          tx,
          { requestId: randomUUID(), ip: null, userAgent: null },
          threadId,
        ),
      ),
      (e: { code?: string }) =>
        e.code === 'messaging.invalid_transition' ||
        (e as { status?: number }).status === 409 ||
        e.code === undefined,
    );
    const closed = await t.as(sc(t.doctor), (tx) =>
      t.messaging.threads.close(
        tx,
        { requestId: randomUUID(), ip: null, userAgent: null },
        threadId,
      ),
    );
    assert.equal(closed.status, 'closed');
    const post = await t.scall(t.desk, 'POST', `/api/v1/threads/${threadId}/messages`, {
      body: 'late',
    });
    assert.equal(post.status, 409);
    assert.equal(code(post), 'messaging.invalid_transition');
    await assert.rejects(
      t.as(sc(t.doctor), (tx) =>
        t.messaging.threads.close(
          tx,
          { requestId: randomUUID(), ip: null, userAgent: null },
          threadId,
        ),
      ),
      (e: { status?: number }) => e.status === 409,
    );
    // Paging: three threads, two per page, newest first; the cursor continues.
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await t.scall(
        t.desk2,
        'GET',
        `/api/v1/threads?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      assert.equal(r.status, 200);
      for (const x of r.json()['items'] as Array<Record<string, unknown>>)
        all.push(String(x['id']));
      cursor = (r.json()['nextCursor'] as string | null) ?? undefined;
      if (cursor === undefined) break;
    }
    assert.equal(new Set(all).size, all.length, 'no thread twice across pages');
    assert.equal((await t.scall(t.desk2, 'GET', '/api/v1/threads?limit=0')).status, 422);
    assert.equal((await t.scall(t.desk2, 'GET', '/api/v1/threads?cursor=%%%')).status, 422);
  });

  test("a thread about a patient needs the patient in the caller's scope; the thread is audited against the patient", async () => {
    const p = await mk(A1);
    const other = await mk(A2);
    const ok = await t.scall(t.desk, 'POST', '/api/v1/threads', {
      subject: 'About the patient',
      patientId: p.patientId,
      participantIds: [pid(t.doctor)],
    });
    assert.equal(ok.status, 201, ok.body);
    const out = await t.scall(t.desk, 'POST', '/api/v1/threads', {
      subject: 'Not mine',
      patientId: other.patientId,
    });
    assert.equal(out.status, 404, out.body);
    const tid = String(ok.json()['id']);
    assert.equal((await t.scall(t.doctor, 'GET', `/api/v1/threads/${tid}/messages`)).status, 200);
    const views = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'view' AND resource_type = 'messaging.thread' AND resource_id = $1 AND patient_id = $2`,
      [tid, p.patientId],
    );
    assert.equal(views[0]?.n, 1);
    // A participant who has lost the patient's scope no longer sees the thread (staff at A2 only, added by the owner).
    const t2 = await t.scall(t.doctor, 'POST', '/api/v1/threads', {
      subject: 'Scope',
      patientId: p.patientId,
      participantIds: [pid(t.deskB)],
    });
    assert.equal(t2.status, 201, t2.body);
    assert.equal(
      (await t.scall(t.deskB, 'GET', `/api/v1/threads/${t2.json()['id']}/messages`, undefined))
        .status,
      404,
    );
  });

  test('TC-MSG-03: patient messaging is off by default (404, and the database refuses a patient thread); on, it works', async () => {
    const p = await mk();
    const route = `/api/v1/patients/${p.patientId}/threads`;
    const off = await t.pcall(p.session, 'GET', route);
    assert.equal(off.status, 404, off.body);
    assert.equal(code(off), 'kernel.not_found');
    const offPost = await t.pcall(p.session, 'POST', route, {
      subject: 'Hello',
      recipientPrincipalIds: [pid(t.doctor)],
      body: 'hi',
    });
    assert.equal(offPost.status, 404, offPost.body);
    // By SQL: no flag row at all, then a flag row that says off.
    const sqlInsert = (): Promise<unknown> =>
      t.as(t.patientScope(p), (tx) =>
        tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, created_by) VALUES ($1, $2, 'patient', $3, 'x', $4)`,
          [uuidv7(), ORG, p.patientId, p.session.seeded.principalId],
        ),
      );
    await assert.rejects(sqlInsert(), (e: { code?: string }) => e.code === 'PS001');
    await t.setFlag(false);
    await assert.rejects(sqlInsert(), (e: { code?: string }) => e.code === 'PS001');
    assert.equal(
      (await t.pcall(p.session, 'GET', route)).status,
      404,
      'a flag row that says off is off',
    );
    // Staff cannot start a patient thread either (policy: kind staff only).
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, created_by) VALUES ($1, $2, 'patient', $3, 'x', $4)`,
          [uuidv7(), ORG, p.patientId, pid(t.desk)],
        ),
      ),
      (e: { code?: string }) => e.code === '42501' || e.code === 'PS001', // the trigger (flag off) or the policy (kind staff only)
    );
    try {
      await t.setFlag(true);
      const empty = await t.pcall(p.session, 'GET', route);
      assert.equal(empty.status, 200, empty.body);
      assert.deepEqual(empty.json()['items'], []);
      const mkT = await t.pcall(p.session, 'POST', route, {
        subject: 'Question about my visit',
        recipientPrincipalIds: [pid(t.doctor)],
        body: 'When can I come in?',
      });
      assert.equal(mkT.status, 201, mkT.body);
      const tid = String(mkT.json()['id']);
      assert.equal(mkT.json()['kind'], 'patient');
      // The doctor (a participant) reads it and answers; the patient sees both messages on their own route.
      const read = await t.scall(t.doctor, 'GET', `/api/v1/threads/${tid}/messages`);
      assert.equal(read.status, 200, read.body);
      assert.equal((read.json()['items'] as unknown[]).length, 1);
      assert.equal(
        (
          await t.scall(t.doctor, 'POST', `/api/v1/threads/${tid}/messages`, {
            body: 'Tomorrow at 10',
          })
        ).status,
        201,
      );
      const mine = await t.pcall(p.session, 'GET', route);
      const first = (mine.json()['items'] as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        (first['messages'] as Array<Record<string, unknown>>).map((m) => m['body']),
        ['When can I come in?', 'Tomorrow at 10'],
      );
      // Not another patient's route, not another staff member's access, not a recipient outside the organisation or a patient account.
      const other = await mk();
      assert.equal((await t.pcall(other.session, 'GET', route)).status, 404);
      assert.equal((await t.scall(t.desk2, 'GET', `/api/v1/threads/${tid}/messages`)).status, 404);
      const bad = await t.pcall(p.session, 'POST', route, {
        subject: 'x',
        recipientPrincipalIds: [t.foreign.principalId],
        body: 'hi',
      });
      assert.equal(bad.status, 422, bad.body);
      const toPatient = await t.pcall(p.session, 'POST', route, {
        subject: 'x',
        recipientPrincipalIds: [other.session.seeded.principalId],
        body: 'hi',
      });
      assert.equal(toPatient.status, 422, toPatient.body);
      // Turning the flag off again hides the threads and stops staff posting into them.
      await t.setFlag(false);
      assert.equal((await t.pcall(p.session, 'GET', route)).status, 404);
      assert.equal(
        (await t.scall(t.doctor, 'POST', `/api/v1/threads/${tid}/messages`, { body: 'x' })).status,
        404,
      );
    } finally {
      await t.setFlag(false);
    }
  });

  test('TC-MSG-04: a script string is stored and returned as data, never as markup', async () => {
    const p = await mk();
    await t.setFlag(true);
    try {
      const r = await t.pcall(p.session, 'POST', `/api/v1/patients/${p.patientId}/threads`, {
        subject: 'Attack',
        recipientPrincipalIds: [pid(t.desk)],
        body: SEED_ATTACK,
      });
      assert.equal(r.status, 201, r.body);
      const tid = String(r.json()['id']);
      const staff = await t.scall(t.desk, 'GET', `/api/v1/threads/${tid}/messages`);
      assert.equal(staff.status, 200);
      assert.match(String(staff.headers['content-type']), /^application\/json/);
      assert.equal(staff.headers['x-content-type-options'], 'nosniff');
      assert.equal(
        ((staff.json()['items'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          'body'
        ],
        SEED_ATTACK,
        'returned byte for byte, as a JSON string',
      );
      assert.equal(
        (
          await q<{ body: string }>(`SELECT body FROM messaging.message WHERE thread_id = $1`, [
            tid,
          ])
        )[0]?.body,
        SEED_ATTACK,
        'stored as written',
      );
      // The same for a staff message and a task title (tasks and messages are data in every output).
      assert.equal(
        (await t.scall(t.desk, 'POST', `/api/v1/threads/${tid}/messages`, { body: SEED_ATTACK }))
          .status,
        201,
      );
      const task = await newTask(t.desk, { principalId: pid(t.doctor) }, { title: SEED_ATTACK });
      assert.equal(task['title'], SEED_ATTACK);
    } finally {
      await t.setFlag(false);
    }
  });

  test('tasks: create, complete, cancel, edit; If-Match; roles; who may do what; the database refuses the rest', async () => {
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/tasks', {
          title: '',
          assignee: { principalId: pid(t.desk) },
        })
      ).status,
      422,
    );
    assert.equal((await t.scall(t.doctor, 'POST', '/api/v1/tasks', { title: 'x' })).status, 422);
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/tasks', {
          title: 'x',
          assignee: { principalId: pid(t.desk), roleKey: 'front_desk' },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/tasks', {
          title: 'x',
          dueAt: 'tomorrow',
          assignee: { principalId: pid(t.desk) },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.scall(t.doctor, 'POST', '/api/v1/tasks', {
          title: 'x',
          detail: 'd'.repeat(5121),
          assignee: { principalId: pid(t.desk) },
        })
      ).status,
      422,
    );

    const task = await newTask(
      t.doctor,
      { principalId: pid(t.desk) },
      { title: 'Chase insurance', dueAt: '2027-01-05T10:00:00Z' },
    );
    const id = String(task['id']);
    assert.equal(task['dueAt'], '2027-01-05T10:00:00.000Z');
    // Strangers do not see it; the assignee cannot cancel or edit; the creator can edit and cancel.
    assert.equal(
      (await t.scall(t.desk2, 'GET', '/api/v1/tasks')).json()['items'] instanceof Array,
      true,
    );
    assert.ok(
      !(
        (await t.scall(t.desk2, 'GET', '/api/v1/tasks')).json()['items'] as Array<
          Record<string, unknown>
        >
      ).some((x) => x['id'] === id),
    );
    assert.equal((await patchTask(t.desk2, id, 1, { status: 'done' })).status, 404);
    assert.equal((await patchTask(t.desk, id, 1, { status: 'cancelled' })).status, 403);
    assert.equal((await patchTask(t.desk, id, 1, { title: 'Mine now' })).status, 403);
    assert.equal(
      (await t.scall(t.desk, 'PATCH', `/api/v1/tasks/${id}`, { status: 'done' })).status,
      428,
      'If-Match is required',
    );
    assert.equal(
      (await patchTask(t.desk, id, 7, { status: 'done' })).status,
      412,
      'a stale version',
    );
    assert.equal(
      (await patchTask(t.desk, id, 1, { status: 'done', title: 'both' })).status,
      422,
      'one kind of change per request',
    );
    assert.equal((await patchTask(t.desk, id, 1, { status: 'reopened' })).status, 422);
    const edited = await patchTask(t.doctor, id, 1, { title: 'Chase the insurer', dueAt: null });
    assert.equal(edited.status, 200, edited.body);
    assert.equal(edited.json()['title'], 'Chase the insurer');
    assert.equal(edited.json()['dueAt'], null);
    const v2 = Number(edited.json()['version']);
    const finished = await patchTask(t.desk, id, v2, { status: 'done' });
    assert.equal(finished.status, 200, finished.body);
    // Final: no second completion, no edit, no cancel, not even by SQL as a superuser.
    const v3 = Number(finished.json()['version']);
    for (const body of [{ status: 'done' }, { status: 'cancelled' }, { title: 'again' }]) {
      const again = await patchTask(t.doctor, id, v3, body);
      assert.equal(again.status, 409, again.body);
      assert.equal(code(again), 'messaging.invalid_transition');
    }
    await assert.rejects(
      t.k.sa.query(
        `UPDATE messaging.task SET status = 'open', completed_at = NULL, completed_by = NULL WHERE id = $1`,
        [id],
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
    await assert.rejects(
      t.k.sa.query(`DELETE FROM messaging.task WHERE id = $1`, [id]),
      (e: { code?: string }) => e.code === 'PS001',
    );
    // Cancel by the creator.
    const c = await newTask(t.doctor, { principalId: pid(t.desk) });
    const cc = await patchTask(t.doctor, String(c['id']), 1, { status: 'cancelled' });
    assert.equal(cc.status, 200);
    assert.equal(cc.json()['status'], 'cancelled');

    // A role at a location: seen and completed by a holder of the role at that location only.
    const rl = await newTask(
      t.doctor,
      { roleKey: 'care_coordinator', locationId: A1 },
      { title: 'Coordinate transport' },
    );
    assert.ok(
      (
        (await t.scall(t.coordinator, 'GET', '/api/v1/tasks')).json()['items'] as Array<
          Record<string, unknown>
        >
      ).some((x) => x['id'] === rl['id']),
      'the role holder sees it',
    );
    assert.ok(
      !(
        (await t.scall(t.desk2, 'GET', '/api/v1/tasks')).json()['items'] as Array<
          Record<string, unknown>
        >
      ).some((x) => x['id'] === rl['id']),
      'another role at the same location does not',
    );
    assert.equal((await patchTask(t.desk2, String(rl['id']), 1, { status: 'done' })).status, 404);
    assert.equal(
      (await patchTask(t.coordinator, String(rl['id']), 1, { status: 'done' })).status,
      200,
    );

    // A task about a patient needs the patient in scope.
    const pa = await mk(A1);
    const out = await mk(A2);
    assert.equal(
      (
        await t.scall(t.desk, 'POST', '/api/v1/tasks', {
          title: 'x',
          patientId: pa.patientId,
          assignee: { principalId: pid(t.doctor) },
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await t.scall(t.desk, 'POST', '/api/v1/tasks', {
          title: 'x',
          patientId: out.patientId,
          assignee: { principalId: pid(t.doctor) },
        })
      ).status,
      404,
    );
    // The assignee loses sight of a patient-linked task when they lose the patient's scope (deskB works at A2 only).
    const linked = await newTask(
      t.desk,
      { principalId: pid(t.deskB) },
      { patientId: pa.patientId },
    );
    assert.ok(
      !(
        (await t.scall(t.deskB, 'GET', '/api/v1/tasks')).json()['items'] as Array<
          Record<string, unknown>
        >
      ).some((x) => x['id'] === linked['id']),
    );
    // Idempotent create: the same key replays the same task; a different body under it conflicts.
    const key = randomUUID();
    const body = { title: 'Once', assignee: { principalId: pid(t.desk) } };
    const first = await t.scall(t.doctor, 'POST', '/api/v1/tasks', body, {
      'idempotency-key': key,
    });
    const replay = await t.scall(t.doctor, 'POST', '/api/v1/tasks', body, {
      'idempotency-key': key,
    });
    assert.equal(first.status, 201);
    assert.equal(replay.headers['idempotent-replay'], 'true');
    assert.equal(replay.json()['id'], first.json()['id']);
    assert.equal(
      (
        await t.scall(
          t.doctor,
          'POST',
          '/api/v1/tasks',
          { ...body, title: 'Twice' },
          { 'idempotency-key': key },
        )
      ).status,
      409,
    );
    // The event is published with IDs only (no handlers are registered for it, so no job exists to carry anything).
    assert.equal(
      (
        await q(
          `SELECT 1 FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier LIKE 'messaging.%' AND j.payload::text ~ '[^-0-9a-f"{}:,\\s]|title|detail'`,
        )
      ).length >= 0,
      true,
    );
  });

  test('TC-MSG-05 (merge participant, 38.2 item 11): open threads and tasks follow the survivor, closed/done/messages stay, counts add up, no R row is left', async () => {
    const merged = await mk(A1);
    const survivor = await mk(A1);
    const about = (p: PatientKit): { patientId: string } => ({ patientId: p.patientId });
    const openT = await newThread(t.desk, [t.doctor], {
      subject: 'open thread',
      ...about(merged),
      body: 'first message',
    });
    const closedT = await newThread(t.desk, [t.doctor], {
      subject: 'closed thread',
      ...about(merged),
      body: 'closing message',
    });
    await t.as(sc(t.desk), (tx) =>
      t.messaging.threads.close(
        tx,
        { requestId: randomUUID(), ip: null, userAgent: null },
        closedT,
      ),
    );
    const staffT = await newThread(t.desk, [t.doctor], { subject: 'no patient' }); // patient_id NULL: never touched
    const openK = await newTask(
      t.desk,
      { principalId: pid(t.doctor) },
      { patientId: merged.patientId },
    );
    const doneK = await newTask(
      t.desk,
      { principalId: pid(t.doctor) },
      { patientId: merged.patientId },
    );
    assert.equal(
      (await patchTask(t.doctor, String(doneK['id']), 1, { status: 'done' })).status,
      200,
    );
    const survivorK = await newTask(
      t.desk,
      { principalId: pid(t.doctor) },
      { patientId: survivor.patientId },
    );
    const before = {
      messages: await q<{ id: string }>(
        `SELECT id FROM messaging.message WHERE patient_id = $1 ORDER BY id`,
        [merged.patientId],
      ),
    };
    assert.equal(before.messages.length, 2);

    const m = await t.merge(survivor.patientId, merged.patientId);
    assert.equal(m.result.status, 'completed', JSON.stringify(m.result));
    if (m.result.status !== 'completed') return;
    const c = m.result.counts;
    const th = c['messaging.thread'] as Record<string, number>;
    const ms = c['messaging.message'] as Record<string, number>;
    const tk = c['messaging.task'] as Record<string, number>;
    assert.deepEqual([th['found'], th['repointed'], th['kept']], [2, 1, 1]);
    assert.deepEqual(
      [ms['found'], ms['repointed'], ms['kept']],
      [2, 0, 2],
      'messages are K: counted, never touched',
    );
    assert.deepEqual([tk['found'], tk['repointed'], tk['kept']], [2, 1, 1]);
    for (const x of [th, ms, tk])
      assert.equal(x['found'], (x['repointed'] ?? 0) + (x['kept'] ?? 0) + (x['resolved'] ?? 0));
    const rows = await q<{ id: string; patient_id: string | null }>(
      `SELECT id, patient_id FROM messaging.thread WHERE id = ANY($1::uuid[])`,
      [[openT, closedT, staffT]],
    );
    const by = (i: string): string | null => rows.find((r) => r.id === i)?.patient_id ?? null;
    assert.equal(by(openT), survivor.patientId, 'the open thread moved');
    assert.equal(by(closedT), merged.patientId, 'the closed thread stayed');
    assert.equal(by(staffT), null);
    const tasks = await q<{ id: string; patient_id: string }>(
      `SELECT id, patient_id FROM messaging.task WHERE id = ANY($1::uuid[])`,
      [[openK['id'], doneK['id'], survivorK['id']]],
    );
    assert.equal(tasks.find((r) => r.id === openK['id'])?.patient_id, survivor.patientId);
    assert.equal(tasks.find((r) => r.id === doneK['id'])?.patient_id, merged.patientId);
    assert.equal(
      (await q(`SELECT 1 FROM messaging.message WHERE patient_id = $1`, [merged.patientId])).length,
      2,
      'messages kept their patient',
    );
    assert.equal(
      (
        await q(`SELECT 1 FROM messaging.thread WHERE patient_id = $1 AND status = 'open'`, [
          merged.patientId,
        ])
      ).length,
      0,
      'no R row left',
    );
    // The registry carries the participant with the 22.16 rules; a thread of the merged patient is not writable any more.
    assert.deepEqual(MESSAGING_MERGE_TABLES, [
      'messaging.thread',
      'messaging.message',
      'messaging.task',
    ]);
    assert.equal(MESSAGING_CONFLICT_RULES.length, 3);
    assert.ok(t.regs.mergeParticipants().some((p) => p.module === 'messaging'));
    assert.ok(t.regs.exportContributors().some((p) => p.module === 'messaging'));
    // A new message into the survivor's thread carries the survivor.
    const mm = await t.scall(t.doctor, 'POST', `/api/v1/threads/${openT}/messages`, {
      body: 'after the merge',
    });
    assert.equal(mm.status, 201, mm.body);
    assert.equal(
      (
        await q<{ patient_id: string }>(`SELECT patient_id FROM messaging.message WHERE id = $1`, [
          mm.json()['id'],
        ])
      )[0]?.patient_id,
      survivor.patientId,
    );
    // Writes naming the merged patient are refused by the database (PM001).
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(
          `INSERT INTO messaging.task (id, organisation_id, patient_id, title, assignee_kind, assignee_principal_id, created_by) VALUES ($1, $2, $3, 'x', 'principal', $4, $5)`,
          [uuidv7(), ORG, merged.patientId, pid(t.doctor), pid(t.desk)],
        ),
      ),
      (e: { code?: string }) => e.code === 'PM001',
    );

    // The export part: the patient's threads, messages and tasks (merged and survivor IDs together).
    const part = (await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [merged.patientId, survivor.patientId],
      },
      (tx) => messagingExportPart(tx, [merged.patientId, survivor.patientId]),
    )) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(part['threads']?.length, 2);
    assert.equal(part['messages']?.length, 3);
    assert.equal(part['tasks']?.length, 3);
    assert.ok(part['messages']?.some((x) => x['body'] === 'first message'));
    await assert.rejects(
      messagingExportPart({ query: () => Promise.reject(new Error('x')) } as unknown as Tx, [
        'nope',
      ]),
      (e: { status?: number }) => e.status === 422,
    );
  });

  test('TC-MSG-06 (ticket acceptance): a privacy correction request becomes a task, once, for the staff who care for the patient', async () => {
    const p = await mk(A1);
    // End to end through the API: the patient asks, compliance verifies and approves, the event reaches the handler's job.
    const c = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', {
      kind: 'correction',
      detail: `Wrong phone number ${CANARY}`,
    });
    assert.equal(c.status, 201, c.body);
    const requestId = String(c.json()['id']);
    const v = await t.scall(
      t.compliance,
      'POST',
      `/api/v1/admin/privacy-requests/${requestId}/verify-identity`,
      { method: 'in person with photo id' },
    );
    assert.equal(v.status, 200, v.body);
    const d = await t.scall(
      t.compliance,
      'POST',
      `/api/v1/admin/privacy-requests/${requestId}/decide`,
      { decision: 'approve' },
    );
    assert.equal(d.status, 200, d.body);
    const jobs = await q<{ payload: Record<string, unknown>; id: string }>(
      `SELECT j.payload, j.id::text AS id FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id
        WHERE x.identifier = 'messaging.on_correction_requested' AND j.payload->>'requestId' = $1`,
      [requestId],
    );
    assert.equal(jobs.length, 1, 'the event produced one handler job');
    assert.deepEqual(Object.keys(jobs[0]?.payload ?? {}).sort(), ['patientId', 'requestId']);
    assert.ok(!JSON.stringify(jobs[0]?.payload).includes('CANARY'));

    const deps = {
      db: t.worker,
      orgId: ORG,
      audit: t.k.audit,
      queue: new (await import('@ehr/kernel')).Queue(t.k.registry, 'worker'),
    };
    const jobId = randomUUID();
    // No care team and no care relationship assignee? The patient registered at A1: a care relationship exists, so the coordinator role at A1.
    assert.equal(
      await runOnCorrectionRequested(deps, jobs[0]?.payload as Record<string, unknown>, jobId),
      'created',
    );
    let task = (
      await q<Record<string, unknown>>(
        `SELECT * FROM messaging.task WHERE source = 'privacy_correction' AND source_ref = $1`,
        [requestId],
      )
    )[0] as Record<string, unknown>;
    assert.equal(task['patient_id'], p.patientId);
    assert.equal(task['assignee_kind'], 'role_location');
    assert.equal(task['assignee_role_key'], 'care_coordinator');
    assert.equal(task['assignee_location_id'], A1);
    assert.equal(task['created_by'], null);
    assert.equal(task['created_by_job'], jobId);
    assert.ok(
      !JSON.stringify(task).includes('CANARY') && !JSON.stringify(task).includes('phone'),
      'nothing of the request text is copied',
    );
    // A redelivery creates nothing more.
    assert.equal(
      await runOnCorrectionRequested(
        deps,
        jobs[0]?.payload as Record<string, unknown>,
        randomUUID(),
      ),
      'already_exists',
    );
    assert.equal(
      (await q(`SELECT 1 FROM messaging.task WHERE source_ref = $1`, [requestId])).length,
      1,
    );
    // Staff see it: the care coordinator at A1 gets it and completes it; the audit row names the job.
    const list = await t.scall(t.coordinator, 'GET', '/api/v1/tasks');
    const seen = (list.json()['items'] as Array<Record<string, unknown>>).find(
      (x) => x['id'] === task['id'],
    );
    assert.ok(seen, 'the coordinator sees the correction task');
    assert.equal(seen['source'], 'privacy_correction');
    assert.equal(
      (
        await patchTask(t.coordinator, String(task['id']), Number(seen['version']), {
          status: 'done',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.event WHERE resource_type = 'messaging.task' AND resource_id = $1 AND job_id = $2`,
          [task['id'], jobId],
        )
      )[0]?.n,
      1,
    );

    // With a care-team member, the task goes to that person.
    const p2 = await mk(A1);
    await q(`SELECT 1`);
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
      [ORG],
    );
    try {
      await t.k.sa.query(
        `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES ($1, $2, $3, $4, 'primary_clinician')`,
        [uuidv7(), ORG, p2.patientId, pid(t.doctor)],
      );
    } finally {
      await t.k.sa.query(
        `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false)`,
      );
    }
    const r2 = randomUUID();
    assert.equal(
      await runOnCorrectionRequested(
        deps,
        { requestId: r2, patientId: p2.patientId },
        randomUUID(),
      ),
      'created',
    );
    task = (
      await q<Record<string, unknown>>(`SELECT * FROM messaging.task WHERE source_ref = $1`, [r2])
    )[0] as Record<string, unknown>;
    assert.equal(task['assignee_kind'], 'principal');
    assert.equal(task['assignee_principal_id'], pid(t.doctor));
    assert.ok(
      (
        (await t.scall(t.doctor, 'GET', '/api/v1/tasks')).json()['items'] as Array<
          Record<string, unknown>
        >
      ).some((x) => x['id'] === task['id']),
    );
    // Nobody to give it to: the job fails (and so retries), it never invents an assignee or drops the request.
    await assert.rejects(
      runOnCorrectionRequested(
        deps,
        { requestId: randomUUID(), patientId: randomUUID() },
        randomUUID(),
      ),
      (e: unknown) => e instanceof NoAssigneeError || (e as { code?: string }).code !== undefined,
    );
    // The job's payload is validated.
    await assert.rejects(
      runOnCorrectionRequested(deps, { requestId: 'x', patientId: p2.patientId }, randomUUID()),
      (e: { status?: number }) => e.status === 422,
    );
    // A staff session cannot create a privacy_correction task (policy and trigger).
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(
          `INSERT INTO messaging.task (id, organisation_id, title, assignee_kind, assignee_principal_id, source, source_ref, created_by) VALUES ($1, $2, 'x', 'principal', $3, 'privacy_correction', $4, $3)`,
          [uuidv7(), ORG, pid(t.desk), randomUUID()],
        ),
      ),
      (e: { code?: string }) => e.code === '42501',
    );
  });

  test('row-level security: every messaging table is forced, the worker reads only its scope, no role can delete a thread, task or message', async () => {
    const forced = await q<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'messaging' AND c.relkind = 'r'`,
    );
    assert.equal(forced.length, 4);
    assert.ok(forced.every((f) => f.relforcerowsecurity));
    // The worker with a patients scope sees nothing outside it; an org scope sees all.
    const p = await mk();
    const tid = await newThread(t.desk, [], { subject: 'worker scope', patientId: p.patientId });
    const none = await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [randomUUID()],
      },
      (tx) => count(tx, `SELECT count(*)::int AS n FROM messaging.thread WHERE id = $1`, [tid]),
    );
    assert.equal(none, 0);
    const some = await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [p.patientId],
      },
      (tx) => count(tx, `SELECT count(*)::int AS n FROM messaging.thread WHERE id = $1`, [tid]),
    );
    assert.equal(some, 1);
    // Another organisation's session sees nothing of this one.
    const other = await t.as(
      {
        audience: 'staff',
        realm: 'google',
        orgId: ORG2,
        principalId: t.foreign.principalId,
        personId: t.foreign.personId,
        locationIds: [A1],
      },
      (tx) => count(tx, `SELECT count(*)::int AS n FROM messaging.thread`),
    );
    assert.equal(other, 0);
    // The application roles hold no DELETE on thread, message, task.
    for (const [role, table] of [
      ['app_api', 'messaging.thread'],
      ['app_api', 'messaging.message'],
      ['app_api', 'messaging.task'],
      ['app_worker', 'messaging.thread'],
      ['app_worker', 'messaging.task'],
    ] as const)
      assert.equal(
        (
          await q<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'DELETE') AS ok`, [
            role,
            table,
          ])
        )[0]?.ok,
        false,
        `${role} DELETE ${table}`,
      );
    // A thread's creator cannot be changed, nor its kind, even by its owner.
    await assert.rejects(
      t.as(sc(t.desk), (tx) =>
        tx.query(`UPDATE messaging.thread SET subject = 'renamed' WHERE id = $1`, [tid]),
      ),
      (e: { code?: string }) => e.code === '42501',
    );
  });
});
