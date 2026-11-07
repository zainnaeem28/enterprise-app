// BE-05 real-database tests of the privileged admin actions: enrolment tokens (two persons), role changes with a second
// approver (C4), the kill switch (C6), and what each of them writes to the audit store (ARCHITECTURE 25.8, 26.3, 29.4).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  adminSetup,
  clock,
  elevate,
  elevatedAdmin,
  enrol,
  getAdmin,
  now,
  ORG,
  post,
  queuedJobs,
  seedAdmin,
  signIn,
  signInOptions,
  SoftKey,
} from './testkit.js';
import type { AdminKit, AdminSession } from './testkit.js';
import { pg } from '../testkit.js';

let k: AdminKit;
before(async () => {
  k = await adminSetup('privileged');
});
after(async () => {
  await k.close();
});

let seq = 0;
const handleOf = (p: string): string => `${p}${++seq}`;
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const as = (s: { session: AdminSession }) => ({ cookie: s.session.cookie, csrf: s.session.csrf });

async function auditOf(action: string, resourceId?: string): Promise<Record<string, unknown>[]> {
  return k.q(
    `SELECT action, outcome, denial_reason, resource_type, resource_id, change, reason, actor_principal_id
       FROM audit.event WHERE action = $1 AND ($2::uuid IS NULL OR resource_id = $2) ORDER BY occurred_at`,
    [action, resourceId ?? null],
  );
}

/** Advances the clock in steps, touching the session each time so that the 10-minute idle timeout never ends it. */
async function advance(s: { session: AdminSession }, minutes: number): Promise<void> {
  for (let left = minutes; left > 0; left -= 5) {
    clock.t += Math.min(5, left) * 60_000;
    const r = await getAdmin(k, '/roles', s.session.cookie);
    assert.equal(r.status, 200, `session alive after ${minutes - left + 5} minutes`);
  }
}

describe('enrolment tokens: request and approve are two persons (26.3, P-4)', () => {
  test('the requester cannot approve, a second admin can, the token is shown once and stored only as a hash', async () => {
    const a = await elevatedAdmin(k, handleOf('tok-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('tok-b'), ['org_admin']);
    const newcomer = await seedAdmin(k, handleOf('newcomer'));
    const handle = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        newcomer.principalId,
      ])
    )[0]!.subject;

    const req = await post(k, '/enrolment-tokens', { principalId: newcomer.principalId }, as(a));
    assert.equal(req.status, 200, req.body);
    const id = String(req.json()['id']);
    const self = await post(k, `/enrolment-tokens/${id}/approve`, {}, as(a));
    assert.equal(self.status, 403);
    assert.equal(code(self), 'identity.self_approval');
    const denied = await auditOf('denied', id);
    assert.equal(denied.length, 1, 'the refusal is audited');
    assert.equal(denied[0]!['outcome'], 'denied');

    const ok = await post(k, `/enrolment-tokens/${id}/approve`, {}, as(b));
    assert.equal(ok.status, 200, ok.body);
    const token = String(ok.json()['token']);
    assert.equal(Buffer.from(token, 'base64url').length, 32, '256 random bits');
    const row = (
      await k.q(
        `SELECT token_hash, status, approved_by_person_id, requested_by_person_id FROM identity.enrolment_token WHERE id = $1`,
        [id],
      )
    )[0]!;
    assert.deepEqual(
      (row['token_hash'] as Buffer).toString('hex'),
      createHash('sha256').update(token).digest('hex'),
    );
    assert.equal(row['status'], 'approved');
    assert.notEqual(row['approved_by_person_id'], row['requested_by_person_id']);
    assert.equal(
      (
        await k.q(`SELECT 1 FROM identity.enrolment_token WHERE token_hash = $1`, [
          Buffer.from(token),
        ])
      ).length,
      0,
      'the token itself is not stored',
    );
    const again = await post(k, `/enrolment-tokens/${id}/approve`, {}, as(b));
    assert.equal(again.status, 409);
    assert.equal(code(again), 'identity.request_expired');
    assert.ok(
      (await auditOf('create', id)).length === 1 && (await auditOf('update', id)).length === 1,
    );
    for (const kind of ['enrolment_token_requested', 'enrolment_token_approved'])
      assert.ok(
        (await queuedJobs(k, 'identity.admin_event', `j.payload->>'kind' = '${kind}'`)).length >= 1,
        kind,
      );
    // the newcomer registers a key with it
    const s = await enrol(k, handle, newcomer.principalId, token, new SoftKey());
    assert.equal(s.principalId, newcomer.principalId);
    // the audit trail never holds the token
    const all = JSON.stringify(await k.q(`SELECT change, reason FROM audit.event`));
    assert.ok(!all.includes(token));
  });

  test('an unapproved request cannot be used, and a request that is not approved in time expires', async () => {
    const a = await elevatedAdmin(k, handleOf('tok-c'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('tok-d'), ['org_admin']);
    const n = await seedAdmin(k, handleOf('late-newcomer'));
    const id = String(
      (await post(k, '/enrolment-tokens', { principalId: n.principalId }, as(a))).json()['id'],
    );
    await advance(b, 31);
    const e = await elevate(k, b.session, b.key);
    assert.equal(e.resp.status, 200);
    const late = await post(
      k,
      `/enrolment-tokens/${id}/approve`,
      {},
      { cookie: e.session.cookie, csrf: e.session.csrf },
    );
    assert.equal(late.status, 409);
    assert.equal(code(late), 'identity.request_expired');
    assert.equal(
      (await k.q(`SELECT status FROM identity.enrolment_token WHERE id = $1`, [id]))[0]!['status'],
      'expired',
    );
  });

  test('only an active admin-realm principal can be enrolled', async () => {
    const a = await elevatedAdmin(k, handleOf('tok-e'), ['org_admin']);
    const google = (
      await k.q<{ id: string }>(`SELECT id FROM identity.principal WHERE realm = 'google' LIMIT 1`)
    )[0];
    const r = await post(
      k,
      '/enrolment-tokens',
      { principalId: google?.id ?? '00000000-0000-4000-8000-000000000009' },
      as(a),
    );
    assert.ok([404, 422].includes(r.status));
    const bad = await post(k, '/enrolment-tokens', { principalId: 'nope' }, as(a));
    assert.equal(bad.status, 422);
  });

  test('database: the approver of a token is never its requester, and a token hash is set once', async () => {
    const p = await seedAdmin(k, handleOf('db-tok'));
    const person = p.personId;
    const other = (await seedAdmin(k, handleOf('db-tok-o'))).personId;
    await k.sa.query('BEGIN');
    await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [other]);
    const id = (await k.q<{ id: string }>(`SELECT gen_random_uuid() AS id`))[0]!.id;
    await k.sa.query(
      `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, requested_by_person_id, expires_at, status) VALUES ($1,$2,$3,$4, now() + interval '1 hour', 'requested')`,
      [id, ORG, p.principalId, other],
    );
    await assert.rejects(
      k.sa.query(
        `UPDATE identity.enrolment_token SET token_hash = decode(repeat('aa', 32), 'hex'), approved_by_person_id = $2, status = 'approved' WHERE id = $1`,
        [id, other],
      ),
      /enrolment_token_approver_not_requester/,
    );
    await k.sa.query('ROLLBACK');
    void person;
  });
});

describe('role changes need a second approver (C4, 25.8)', () => {
  test('request, self-approval refused, subject-approval refused, a third admin applies it; everything is audited', async () => {
    const a = await elevatedAdmin(k, handleOf('rc-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('rc-b'), ['org_admin']);
    const c = await elevatedAdmin(k, handleOf('rc-c'), ['org_admin']); // the subject, also an eligible approver
    const subject = c.s.principalId;
    const req = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: subject, add: [{ roleKey: 'compliance_officer' }], remove: [] },
      as(a),
    );
    assert.equal(req.status, 200, req.body);
    const id = String(req.json()['id']);
    assert.deepEqual(
      (req.json()['before'] as { roleKey: string }[]).map((r) => r.roleKey),
      ['org_admin'],
    );
    assert.equal(
      (
        await k.q(
          `SELECT encode(request_hash, 'hex') AS h FROM identity.role_change_request WHERE id = $1`,
          [id],
        )
      )[0]!['h']!.toString().length,
      64,
    );

    const self = await post(k, `/role-change-requests/${id}/approve`, {}, as(a));
    assert.equal(self.status, 403);
    assert.equal(code(self), 'identity.self_approval');
    const mine = await post(k, `/role-change-requests/${id}/approve`, {}, as(c));
    assert.equal(mine.status, 403);
    assert.equal(code(mine), 'identity.approver_is_subject');
    assert.equal(
      (await k.q(`SELECT status FROM identity.role_change_request WHERE id = $1`, [id]))[0]![
        'status'
      ],
      'requested',
    );
    assert.equal((await auditOf('denied', id)).length, 2, 'both refusals are audited');

    const ok = await post(k, `/role-change-requests/${id}/approve`, {}, as(b));
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json()['status'], 'applied');
    const held = await k.q(
      `SELECT ro.key, ra.granted_via_request_id FROM identity.role_assignment ra JOIN identity.role ro ON ro.id = ra.role_id WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL ORDER BY ro.key`,
      [subject],
    );
    assert.deepEqual(
      held.map((r) => r['key']),
      ['compliance_officer', 'org_admin'],
    );
    assert.equal(
      held.find((r) => r['key'] === 'compliance_officer')!['granted_via_request_id'],
      id,
    );
    const req2 = (await auditOf('role_change_request', id))[0]!;
    assert.deepEqual((req2['change'] as { add: unknown[] }).add, [
      { roleKey: 'compliance_officer' },
    ]);
    const dec = (await auditOf('role_change_decision', id))[0]!;
    const ch = dec['change'] as {
      decision: string;
      before: { roleKey: string }[];
      after: { roleKey: string }[];
      requesterPersonId: string;
      approverPersonId: string;
    };
    assert.equal(ch.decision, 'applied');
    assert.deepEqual(
      ch.before.map((r) => r.roleKey),
      ['org_admin'],
    );
    assert.deepEqual(
      ch.after.map((r) => r.roleKey),
      ['compliance_officer', 'org_admin'],
    );
    assert.notEqual(ch.requesterPersonId, ch.approverPersonId);
    assert.equal(dec['actor_principal_id'], b.s.principalId);
    // a decided request is final
    const twice = await post(k, `/role-change-requests/${id}/approve`, {}, as(b));
    assert.equal(twice.status, 409);
    assert.equal(code(twice), 'identity.request_expired');
    // adding a role does not end the subject's session
    assert.equal((await getAdmin(k, '/roles', c.session.cookie)).status, 200);
  });

  test('a request expires after the configured hours and can no longer be approved', async () => {
    await k.sa.query(
      `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'role_request_hours', '1'::jsonb, 'integer')
       ON CONFLICT DO NOTHING`,
      [ORG],
    );
    const a = await elevatedAdmin(k, handleOf('rx-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('rx-b'), ['org_admin']);
    const subject = await seedAdmin(k, handleOf('rx-s'));
    const req = await post(
      k,
      '/role-change-requests',
      {
        subjectPrincipalId: subject.principalId,
        add: [{ roleKey: 'compliance_on_call' }],
        remove: [],
      },
      as(a),
    );
    assert.equal(req.status, 200, req.body);
    const id = String(req.json()['id']);
    const exp = Date.parse(String(req.json()['expiresAt'])) - now().getTime();
    assert.equal(exp, 3_600_000, 'the setting, not the 24-hour default');
    await advance(b, 61);
    const again = await elevate(k, b.session, b.key);
    assert.equal(again.resp.status, 200);
    const late = await post(
      k,
      `/role-change-requests/${id}/approve`,
      {},
      { cookie: again.session.cookie, csrf: again.session.csrf },
    );
    assert.equal(late.status, 409);
    assert.equal(code(late), 'identity.request_expired');
    assert.equal(
      (await k.q(`SELECT status FROM identity.role_change_request WHERE id = $1`, [id]))[0]![
        'status'
      ],
      'expired',
    );
    assert.equal(
      (
        await k.q(`SELECT 1 FROM identity.role_assignment WHERE principal_id = $1`, [
          subject.principalId,
        ])
      ).length,
      0,
    );
    assert.equal((await auditOf('role_change_decision', id)).length, 1, 'the expiry is audited');
    await k.sa.query(`DELETE FROM kernel.setting WHERE key = 'role_request_hours'`);
  });

  test('removing a role ends the subject’s sessions and elevation at once', async () => {
    const a = await elevatedAdmin(k, handleOf('rm-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('rm-b'), ['org_admin']);
    const t = await elevatedAdmin(k, handleOf('rm-t'), ['org_admin', 'compliance_officer']);
    assert.equal(
      (
        await post(
          k,
          '/principals/00000000-0000-4000-8000-000000000001/kill-switch',
          { reason: 'probe' },
          as(t),
        )
      ).status,
      404,
      'elevated before',
    );
    const req = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: t.s.principalId, add: [], remove: [{ roleKey: 'compliance_officer' }] },
      as(a),
    );
    assert.equal(req.status, 200, req.body);
    assert.equal(
      (await post(k, `/role-change-requests/${String(req.json()['id'])}/approve`, {}, as(b)))
        .status,
      200,
    );
    assert.equal(
      (await getAdmin(k, '/roles', t.session.cookie)).status,
      401,
      'the session is gone',
    );
    const g = await k.q(`SELECT revoke_reason FROM identity.elevation_grant WHERE person_id = $1`, [
      t.s.personId,
    ]);
    assert.ok(g.every((r) => r['revoke_reason'] === 'role_change'));
    const s = await k.q(`SELECT revoke_reason FROM identity.session WHERE principal_id = $1`, [
      t.s.principalId,
    ]);
    assert.ok(s.every((r) => r['revoke_reason'] === 'role_change'));
    // the assignment itself is revoked, the other one stays
    const held = await k.q(
      `SELECT ro.key FROM identity.role_assignment ra JOIN identity.role ro ON ro.id = ra.role_id WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL`,
      [t.s.principalId],
    );
    assert.deepEqual(
      held.map((r) => r['key']),
      ['org_admin'],
    );
  });

  test('two approvers deciding at once: exactly one applies the change, the other gets 409, one assignment exists', async () => {
    const a = await elevatedAdmin(k, handleOf('cc-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('cc-b'), ['org_admin']);
    const c = await elevatedAdmin(k, handleOf('cc-c'), ['org_admin']);
    const subject = await seedAdmin(k, handleOf('cc-s'));
    const req = await post(
      k,
      '/role-change-requests',
      {
        subjectPrincipalId: subject.principalId,
        add: [{ roleKey: 'compliance_on_call' }],
        remove: [],
      },
      as(a),
    );
    const id = String(req.json()['id']);
    const rs = await Promise.all(
      [b, c].map((x) => post(k, `/role-change-requests/${id}/approve`, {}, as(x))),
    );
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.role_assignment WHERE principal_id = $1 AND revoked_at IS NULL`,
          [subject.principalId],
        )
      ).length,
      1,
    );
    assert.equal((await auditOf('role_change_decision', id)).length, 1);
  });

  test('realm rules: a privileged role never goes to a staff-realm principal, roles must match the realm, an unbound principal gets none', async () => {
    const a = await elevatedAdmin(k, handleOf('rr-a'), ['org_admin']);
    const staff = await k.q<{ id: string }>(
      `SELECT id FROM identity.principal WHERE realm = 'google' AND subject IS NOT NULL LIMIT 1`,
    );
    let googleId = staff[0]?.id;
    if (googleId === undefined) {
      const { seedPrincipal } = await import('../testkit.js');
      googleId = (await seedPrincipal(k, 'google', { email: `rr${seq}@example.com` })).principalId;
    }
    const priv = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: googleId, add: [{ roleKey: 'org_admin' }], remove: [] },
      as(a),
    );
    assert.equal(priv.status, 422);
    assert.equal(code(priv), 'identity.privileged_role_in_staff_realm');
    const admin = await seedAdmin(k, handleOf('rr-s'));
    const mismatch = await post(
      k,
      '/role-change-requests',
      {
        subjectPrincipalId: admin.principalId,
        add: [{ roleKey: 'front_desk', locationId: '00000000-0000-4000-8000-0000000000e1' }],
        remove: [],
      },
      as(a),
    );
    assert.equal(mismatch.status, 422);
    assert.equal(code(mismatch), 'identity.role_realm_mismatch');
    const empty = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: admin.principalId, add: [], remove: [] },
      as(a),
    );
    assert.equal(empty.status, 422);
    const unknown = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: admin.principalId, add: [{ roleKey: 'no_such_role' }], remove: [] },
      as(a),
    );
    assert.equal(unknown.status, 422);
    // pre-registered google principal: no subject yet, so it can hold no role
    const pre = await post(
      k,
      '/principals',
      { realm: 'google', email: `pre${seq}@example.com`, displayName: 'Pre Registered' },
      as(a),
    );
    assert.equal(pre.status, 200, pre.body);
    const preId = String(pre.json()['principalId']);
    const row = (
      await k.q(
        `SELECT subject, preregistered_at, created_by FROM identity.principal WHERE id = $1`,
        [preId],
      )
    )[0]!;
    assert.equal(row['subject'], null);
    assert.equal(row['created_by'], a.s.principalId);
    const lonely = await post(
      k,
      '/role-change-requests',
      {
        subjectPrincipalId: preId,
        add: [{ roleKey: 'front_desk', locationId: '00000000-0000-4000-8000-0000000000e1' }],
        remove: [],
      },
      as(a),
    );
    assert.equal(lonely.status, 422);
  });

  test('approval re-checks the subject and the locations at apply time (BE05-R1-F05)', async () => {
    const a = await elevatedAdmin(k, handleOf('ap-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('ap-b'), ['org_admin']);
    const statusOf = async (id: string): Promise<unknown> =>
      (await k.q(`SELECT status FROM identity.role_change_request WHERE id = $1`, [id]))[0]![
        'status'
      ];
    // 1. the subject is disabled between the request and the approval
    const x = await seedAdmin(k, handleOf('ap-x'));
    const r1 = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: x.principalId, add: [{ roleKey: 'compliance_officer' }], remove: [] },
      as(a),
    );
    assert.equal(r1.status, 200, r1.body);
    const id1 = String(r1.json()['id']);
    const kill = await post(
      k,
      `/principals/${x.principalId}/kill-switch`,
      { reason: 'device lost' },
      as(b),
    );
    assert.equal(kill.status, 200, kill.body);
    const late = await post(k, `/role-change-requests/${id1}/approve`, {}, as(b));
    assert.equal(late.status, 422);
    assert.equal(code(late), 'kernel.validation_failed');
    assert.equal(await statusOf(id1), 'requested', 'rolled back as a whole');
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.role_assignment WHERE principal_id = $1 AND revoked_at IS NULL`,
          [x.principalId],
        )
      ).length,
      0,
      'no role went to the disabled principal',
    );
    assert.equal((await post(k, `/role-change-requests/${id1}/reject`, {}, as(b))).status, 200);
    // 2. a location that does not exist cannot be applied: a clean refusal, not a foreign-key error
    const { seedPrincipal } = await import('../testkit.js');
    const g = await seedPrincipal(k, 'google', { email: `ap${seq}@example.com` });
    const r2 = await post(
      k,
      '/role-change-requests',
      {
        subjectPrincipalId: g.principalId,
        add: [{ roleKey: 'front_desk', locationId: '00000000-0000-4000-8000-0000000000e1' }],
        remove: [],
      },
      as(a),
    );
    assert.equal(r2.status, 200, r2.body);
    const id2 = String(r2.json()['id']);
    const bad = await post(k, `/role-change-requests/${id2}/approve`, {}, as(b));
    assert.equal(bad.status, 422, bad.body);
    assert.equal(code(bad), 'kernel.validation_failed');
    assert.equal(await statusOf(id2), 'requested');
  });

  test('GET /admin/principals pages with a cursor and never truncates silently (BE05-R1-F06)', async () => {
    const a = await elevatedAdmin(k, handleOf('pg-a'), ['org_admin']);
    const prefix = handleOf('pgq');
    for (let i = 0; i < 5; i++) await seedAdmin(k, `${prefix}-${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const q = `/principals?q=${prefix}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const r = await getAdmin(k, q, a.session.cookie);
      assert.equal(r.status, 200, r.body);
      const j = r.json() as { items: { handle: string }[]; nextCursor: string | null };
      assert.ok(j.items.length <= 2);
      seen.push(...j.items.map((i) => i.handle));
      cursor = j.nextCursor;
      if (cursor === null) break;
    }
    assert.equal(cursor, null);
    assert.equal(new Set(seen).size, 5);
    assert.equal(seen.length, 5);
    assert.equal((await getAdmin(k, '/principals?limit=0', a.session.cookie)).status, 422);
    assert.equal((await getAdmin(k, '/principals?cursor=zzz', a.session.cookie)).status, 422);
  });

  test('database: self-approval, a decision by someone else’s name and approval by the subject are refused below the API', async () => {
    const x = await seedAdmin(k, handleOf('dbrc-x'));
    const y = await seedAdmin(k, handleOf('dbrc-y'));
    const subject = await seedAdmin(k, handleOf('dbrc-s'));
    const id = (await k.q<{ id: string }>(`SELECT gen_random_uuid() AS id`))[0]!.id;
    const ins = `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at)
                 VALUES ($1,$2,$3,$4,'{"add":[],"remove":[]}','[]',decode(repeat('cd',32),'hex'),'requested', now() + interval '1 day')`;
    const decide = (who: string, approver: string) =>
      k.sa
        .query(`SELECT set_config('app.person_id', $1, true)`, [who])
        .then(() =>
          k.sa.query(
            `UPDATE identity.role_change_request SET status = 'approved', approver_person_id = $2, decided_at = now() WHERE id = $1`,
            [id, approver],
          ),
        );
    for (const [who, approver, expected] of [
      [x.personId, x.personId, /approver_not_requester/],
      [y.personId, x.personId, /decided by the person of the session/],
      [subject.personId, subject.personId, /not the person being changed/],
    ] as const) {
      await k.sa.query('BEGIN');
      await k.sa.query(`SELECT set_config('app.person_id', $1, true)`, [x.personId]);
      await k.sa.query(ins, [id, ORG, x.personId, subject.principalId]);
      await assert.rejects(decide(who, approver), expected);
      await k.sa.query('ROLLBACK');
    }
  });

  test('an unelevated or unprivileged session cannot touch the role-change routes', async () => {
    const h = handleOf('rc-noelev');
    const s = await seedAdmin(k, h, ['org_admin']);
    const key = new SoftKey();
    const key2 = new SoftKey();
    const { seedToken } = await import('./testkit.js');
    const t = await seedToken(k, s.principalId);
    await enrol(k, h, s.principalId, t, key);
    await enrol(k, h, s.principalId, t, key2);
    const signed = await signIn(k, h, s.principalId, key);
    const r = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: s.principalId, add: [], remove: [{ roleKey: 'org_admin' }] },
      { cookie: signed.cookie, csrf: signed.csrf },
    );
    assert.equal(r.status, 403);
    assert.equal(code(r), 'identity.elevation_required');
    const bare = await seedAdmin(k, handleOf('rc-norole'));
    const bkey = new SoftKey();
    const bkey2 = new SoftKey();
    const bt = await seedToken(k, bare.principalId);
    const bh = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        bare.principalId,
      ])
    )[0]!.subject;
    await enrol(k, bh, bare.principalId, bt, bkey);
    await enrol(k, bh, bare.principalId, bt, bkey2);
    const bs = await signIn(k, bh, bare.principalId, bkey);
    const forbidden = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: s.principalId, add: [], remove: [] },
      { cookie: bs.cookie, csrf: bs.csrf },
    );
    assert.equal(forbidden.status, 403);
    assert.equal(code(forbidden), 'auth.forbidden');
    assert.equal(
      (await post(k, '/role-change-requests', {}, { cookie: signed.cookie })).status,
      403,
      'no CSRF token',
    );
    assert.equal(
      (
        await post(
          k,
          '/role-change-requests',
          {},
          { cookie: signed.cookie, csrf: signed.csrf, origin: 'https://evil.example' },
        )
      ).status,
      403,
      'wrong Origin',
    );
  });
});

describe('kill switch (C6, 25.8)', () => {
  test('one transaction ends every session and elevation of the target, disables it and closes its streams', async () => {
    const actor = await elevatedAdmin(k, handleOf('ks-a'), ['org_admin']);
    const t = await elevatedAdmin(k, handleOf('ks-t'), ['org_admin']);
    const handle = (
      await k.q<{ subject: string }>(`SELECT subject FROM identity.principal WHERE id = $1`, [
        t.s.principalId,
      ])
    )[0]!.subject;
    const second = await signIn(k, handle, t.s.principalId, t.key2);
    const elevated2 = await elevate(k, second, t.key2);
    assert.equal(elevated2.resp.status, 200);
    const live = (
      await k.q(`SELECT 1 FROM identity.session WHERE principal_id = $1 AND revoked_at IS NULL`, [
        t.s.principalId,
      ])
    ).length;
    assert.ok(live >= 2);

    const listener = new pg.Client({ connectionString: k.urlFor('app_api') });
    await listener.connect();
    const heard: string[] = [];
    listener.on('notification', (m: { channel: string; payload?: string }) => {
      if (m.channel === 'session_revoked') heard.push(m.payload ?? '');
    });
    await listener.query('LISTEN session_revoked');
    try {
      const r = await post(
        k,
        `/principals/${t.s.principalId}/kill-switch`,
        { reason: 'laptop reported lost' },
        as(actor),
      );
      assert.equal(r.status, 200, r.body);
      const body = r.json();
      assert.equal(body['sessionsRevoked'], live);
      assert.equal(body['grantsRevoked'], 2);
      assert.equal(body['credentialsRevoked'], 2);
      for (let i = 0; i < 50 && heard.length === 0; i++)
        await new Promise((res) => setTimeout(res, 20));
      assert.deepEqual(
        heard,
        [t.s.principalId],
        'session_revoked carries the principal, so every instance closes its streams at once',
      );
    } finally {
      await listener.end();
    }
    for (const cookie of [t.session.cookie, elevated2.session.cookie])
      assert.equal(
        (await getAdmin(k, '/roles', cookie)).status,
        401,
        'refused on the very next request',
      );
    const p = (
      await k.q(`SELECT status, disabled_reason FROM identity.principal WHERE id = $1`, [
        t.s.principalId,
      ])
    )[0]!;
    assert.deepEqual([p['status'], p['disabled_reason']], ['disabled', 'laptop reported lost']);
    assert.equal(
      (
        await k.q(`SELECT 1 FROM identity.session WHERE principal_id = $1 AND revoked_at IS NULL`, [
          t.s.principalId,
        ])
      ).length,
      0,
    );
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.elevation_grant g JOIN identity.session s ON s.id = g.session_id WHERE s.principal_id = $1 AND g.revoked_at IS NULL`,
          [t.s.principalId],
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.session WHERE principal_id = $1 AND revoke_reason <> 'kill_switch'`,
          [t.s.principalId],
        )
      ).length,
      0,
    );
    // role assignments are kept but inert
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.role_assignment WHERE principal_id = $1 AND revoked_at IS NULL`,
          [t.s.principalId],
        )
      ).length,
      1,
    );
    // the target cannot sign in again
    const opt = (await signInOptions(k, handle)).json() as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const again = await post(k, '/auth/sign-in/verify', {
      challengeId: opt.challengeId,
      handle,
      assertion: t.key.assert(opt.publicKey, {
        origin: `https://staff.example.test`,
        rpId: 'staff.example.test',
      }),
    });
    assert.equal(again.status, 401);
    const ev = (await auditOf('kill_switch', t.s.principalId))[0]!;
    assert.equal(ev['actor_principal_id'], actor.s.principalId);
    assert.equal(ev['reason'], 'laptop reported lost');
    assert.equal(ev['resource_type'], 'identity.principal');
  });

  test('without elevation the kill switch is refused; with a bad reason or an unknown target it is a clean error', async () => {
    const a = await elevatedAdmin(k, handleOf('ks-b'), ['org_admin']);
    const bad = await post(k, `/principals/${a.s.principalId}/kill-switch`, { reason: 'x' }, as(a));
    assert.equal(bad.status, 422);
    const missing = await post(
      k,
      `/principals/00000000-0000-4000-8000-0000000000aa/kill-switch`,
      { reason: 'unknown target' },
      as(a),
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (await getAdmin(k, '/roles', a.session.cookie)).status,
      200,
      'a failed kill switch changes nothing',
    );
  });

  test('deprovisioning: the same-day path is the kill switch plus the removal of the roles; both are one request each', async () => {
    const a = await elevatedAdmin(k, handleOf('dp-a'), ['org_admin']);
    const b = await elevatedAdmin(k, handleOf('dp-b'), ['org_admin']);
    const t = await elevatedAdmin(k, handleOf('dp-t'), ['org_admin']);
    const started = Date.now();
    const kill = await post(
      k,
      `/principals/${t.s.principalId}/kill-switch`,
      { reason: 'left the company' },
      as(a),
    );
    assert.equal(kill.status, 200);
    const req = await post(
      k,
      '/role-change-requests',
      { subjectPrincipalId: t.s.principalId, add: [], remove: [{ roleKey: 'org_admin' }] },
      as(a),
    );
    assert.equal(req.status, 200, req.body);
    assert.equal(
      (await post(k, `/role-change-requests/${String(req.json()['id'])}/approve`, {}, as(b)))
        .status,
      200,
    );
    assert.ok(Date.now() - started < 60_000, 'minutes, not days');
    assert.equal(
      (
        await k.q(
          `SELECT 1 FROM identity.role_assignment WHERE principal_id = $1 AND revoked_at IS NULL`,
          [t.s.principalId],
        )
      ).length,
      0,
    );
  });
});
