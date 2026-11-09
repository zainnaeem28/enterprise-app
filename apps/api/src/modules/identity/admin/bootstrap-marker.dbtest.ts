// INT04-F02b (HEAAA-466), decision log section 5 test 12: the custodian marker principals that identity.bootstrap_admins leaves for
// custodians who are not enrollees cannot sign in, cannot be bound to a real account and cannot hold the admin role. Real PostgreSQL 17,
// the real sign-in path of signin.ts behind the local OIDC conformance IdP.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/identity/admin/bootstrap-marker.dbtest.js
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { browserSignIn, ORG, pg, setup, STAFF_HOST } from '../testkit.js';
import type { Kit } from '../testkit.js';

let k: Kit;
let runId: string;
const markers: { personId: string; principalId: string; subject: string }[] = [];

before(async () => {
  k = await setup({ name: 'bootmark' });
  // identity.admin_event is published by the function; the API-side registry of this kit syncs only the sign-in jobs.
  await k.q(
    `INSERT INTO queue_api.task_type (task_identifier, job_class, api_enqueue, max_attempts)
     VALUES ('identity.admin_event', 'job', true, 8) ON CONFLICT DO NOTHING`,
  );
  // The kit seeds the identity reference data but no organisation row; the function checks that the organisation exists.
  await k.q(
    `INSERT INTO organisation.organisation (id, organisation_id, name, default_time_zone) VALUES ($1, $1, 'Test clinic', 'UTC') ON CONFLICT DO NOTHING`,
    [ORG],
  );
  const c = new pg.Client({ connectionString: k.urlFor('app_bootstrap') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    const hashes = [randomBytes(32), randomBytes(32)];
    const r = await c.query(
      `SELECT identity.bootstrap_admins($1, $2, $3::jsonb, $4::jsonb, $5::bytea[]) AS r`,
      [
        'run-marker',
        'TICKET-MARKER',
        JSON.stringify([
          { handle: 'marker.one', display_name: 'One' },
          { handle: 'marker.two', display_name: 'Two' },
        ]),
        JSON.stringify([
          { display_name: 'Custodian A', idp_id: 'idp-a' },
          { display_name: 'Custodian B', idp_id: 'idp-b' },
        ]),
        hashes,
      ],
    );
    await c.query('COMMIT');
    runId = String((r.rows[0] as { r: { run_id: string } }).r.run_id);
  } finally {
    await c.end();
  }
  for (const r of await k.q<{ person_id: string; id: string; subject: string }>(
    `SELECT person_id, id, subject FROM identity.principal WHERE realm = 'google' AND disabled_reason = 'bootstrap_custodian' ORDER BY subject`,
  ))
    markers.push({ personId: r.person_id, principalId: r.id, subject: r.subject });
});
after(async () => {
  await k?.close();
});

describe('custodian marker principals (decision log D-2)', () => {
  test('each marker has exactly the values of D-2', async () => {
    assert.equal(markers.length, 2);
    assert.ok(runId);
    for (const m of markers) {
      const p = (
        await k.q(
          `SELECT realm, subject, email, status, disabled_reason FROM identity.principal WHERE id = $1`,
          [m.principalId],
        )
      )[0];
      assert.deepEqual(p, {
        realm: 'google',
        subject: `bootstrap-custodian:${m.personId}`,
        email: null,
        status: 'disabled',
        disabled_reason: 'bootstrap_custodian',
      });
    }
  });

  test('the sign-in path with the marker subject does not sign in as the marker', async () => {
    const m = markers[0] as (typeof markers)[number];
    const r = await browserSignIn(k, STAFF_HOST, {
      sub: m.subject,
      email: 'custodian.a@example.com',
      email_verified: true,
      hd: 'example.com',
      name: 'Custodian A',
    });
    assert.equal(r.sid, undefined, 'no session cookie');
    assert.equal(
      Number(
        (
          await k.q(`SELECT count(*) AS n FROM identity.session WHERE principal_id = $1`, [
            m.principalId,
          ])
        )[0]?.['n'],
      ),
      0,
    );
    const p = (
      await k.q(`SELECT status, subject, email FROM identity.principal WHERE id = $1`, [
        m.principalId,
      ])
    )[0];
    assert.deepEqual(p, { status: 'disabled', subject: m.subject, email: null });
  });

  test("sign-in with the custodian's e-mail and another subject never finds the marker: it creates an unrelated principal", async () => {
    const m = markers[1] as (typeof markers)[number];
    const sub = `real-sub-${process.pid}`;
    const r = await browserSignIn(k, STAFF_HOST, {
      sub,
      email: 'custodian.b@example.com',
      email_verified: true,
      hd: 'example.com',
      name: 'Custodian B',
    });
    assert.ok(r.sid, 'a session for the new, unrelated principal');
    const made = (
      await k.q<{ id: string; person_id: string }>(
        `SELECT id, person_id FROM identity.principal WHERE realm = 'google' AND subject = $1`,
        [sub],
      )
    )[0];
    assert.ok(made);
    assert.notEqual(made.id, m.principalId);
    assert.notEqual(made.person_id, m.personId);
    assert.deepEqual(
      (
        await k.q(`SELECT status, subject, email FROM identity.principal WHERE id = $1`, [
          m.principalId,
        ])
      )[0],
      { status: 'disabled', subject: m.subject, email: null },
      'the marker is untouched',
    );
  });

  test('an org_admin assignment to a marker is refused by guard_role_assignment', async () => {
    const m = markers[0] as (typeof markers)[number];
    const req = (
      await k.q<{ id: string }>(
        `SELECT id FROM identity.role_change_request WHERE organisation_id = $1 LIMIT 1`,
        [ORG],
      )
    )[0];
    assert.ok(req, 'the run created role change requests');
    const role = (
      await k.q<{ id: string }>(
        `SELECT id FROM identity.role WHERE organisation_id = $1 AND key = 'org_admin'`,
        [ORG],
      )
    )[0];
    assert.ok(role);
    await assert.rejects(
      k.sa.query(
        `INSERT INTO identity.role_assignment (id, organisation_id, role_id, principal_id, granted_via_request_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [ORG, role.id, m.principalId, req.id],
      ),
      (e: { code?: string; message?: string }) =>
        e.code === 'PS001' && /realm/.test(e.message ?? ''),
    );
  });

  test('the marker subject is immutable (guard_principal): it can never be re-pointed at a real account', async () => {
    const m = markers[0] as (typeof markers)[number];
    await assert.rejects(
      k.sa.query(
        `UPDATE identity.principal SET subject = 'google-sub-of-a-real-person' WHERE id = $1`,
        [m.principalId],
      ),
      (e: { code?: string }) => e.code === 'PS001',
    );
  });
});
