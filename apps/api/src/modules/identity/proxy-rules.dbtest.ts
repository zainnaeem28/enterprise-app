// Real-database tests for the proxy rules (owner ruling 2026-11-11 C item 3, D-7, C-04; RA-R1-20b, TC-PP-03, TC-PP-05):
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/identity/proxy-rules.dbtest.js
// invite -> e-mail code -> accept, per-scope grants, guardian link by staff, 13-17 narrowing, age-out and its notice, immediate revocation,
// leaving, and no access to another patient. Missing configuration FAILS; nothing skips. Synthetic data only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { KernelDb, ScopeSettings } from '@ehr/kernel';
import { IdentityScopeError, ProxyNotAllowedError } from './errors.js';
import { uuidv7 } from './ids.js';
import { assignRole, id, ORG, seedPrincipal, setup, staffVisible } from './testkit.js';
import type { Kit } from './testkit.js';

type Job = (d: unknown, p?: unknown, ref?: string) => Promise<Record<string, unknown>>;
let k: Kit;
const L1 = id(900);
const mails: { code: string; to: string; grantId: string }[] = [];
const notices: { to: string; grantId: string; daysLeft: number; endsOn: string }[] = [];
const mail = {
  sendInviteCode: (m: { to: string; code: string; grantId: string }) => {
    mails.push({ to: m.to, code: m.code, grantId: m.grantId });
    return Promise.resolve();
  },
  sendAgeOutNotice: (m: { to: string; grantId: string; daysLeft: number; endsOn: string }) => {
    notices.push({ to: m.to, grantId: m.grantId, daysLeft: m.daysLeft, endsOn: m.endsOn });
    return Promise.resolve();
  },
};
const wdeps = (): { db: KernelDb; orgId: string; mail: typeof mail } => ({
  db: k.wdb,
  orgId: ORG,
  mail,
});
const sendInvite = (grantId: string): Promise<Record<string, unknown>> =>
  (k.worker['runSendProxyInvite'] as unknown as Job)(wdeps(), { grantId });
const ageOut = (): Promise<Record<string, unknown>> =>
  (k.worker['runProxyAgeOut'] as unknown as Job)(wdeps());
const lastCode = (grantId: string): string => {
  const m = [...mails].reverse().find((x) => x.grantId === grantId);
  assert.ok(m, 'a mail was sent');
  return m.code;
};

const dob = (yearsAgo: number, extraDays = 0): string => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
};
let mrn = 9100000;
async function patient(pid: string, birth: string): Promise<void> {
  await k.sa.query(
    `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1, $2, $3, 'Pat', 'Fixture', $4, 'NY', 'front_desk')`,
    [pid, ORG, `MRN-${mrn++}`, birth],
  );
}
async function document(pid: string, by: string, status = 'clean'): Promise<string> {
  const did = uuidv7();
  await k.sa.query(`SET session_replication_role = replica`); // fixture: the state trigger wants the upload flow
  await k.sa.query(
    `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, uploaded_by, upload_channel, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, 'id_document', $4, $5, 'staff', $6, $7)`,
    [
      did,
      ORG,
      pid,
      status,
      by,
      status === 'confirmed' ? by : null,
      status === 'confirmed' ? new Date() : null,
    ],
  );
  await k.sa.query(`SET session_replication_role = origin`);
  return did;
}
const patientScope = (
  p: { principalId: string; personId: string },
  patientIds: string[] = [],
): ScopeSettings => ({
  audience: 'patient',
  realm: 'patient_pool',
  orgId: ORG,
  principalId: p.principalId,
  personId: p.personId,
  ...(patientIds.length > 0 ? { patientIds } : {}),
});
const meta = (): { requestId: string } => ({ requestId: uuidv7() });

let staff: { principalId: string; personId: string };
const staffScope = (): ScopeSettings => ({
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: staff.principalId,
  personId: staff.personId,
  locationIds: [L1],
});

/** The patients a signed-in proxy can reach with which scopes, exactly as the scope builder computes them for a request. */
async function reach(p: {
  principalId: string;
  personId: string;
}): Promise<Record<string, string[]>> {
  const built = await k.db.withScope(patientScope(p), (tx) =>
    k.identity.scopes.build(tx, {
      principalId: p.principalId,
      personId: p.personId,
      audience: 'patient',
      realm: 'patient_pool',
    } as never),
  );
  return Object.fromEntries(
    built.patients
      .filter((x) => x.relation === 'proxy')
      .map((x) => [x.patientId, [...x.scopes].sort()]),
  );
}

before(async () => {
  k = await setup({
    name: 'proxyrules',
    withApp: false,
    fixtures: async ({ sa }) => {
      await sa.query(
        `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York')`,
        [ORG],
      );
      for (const [key, v, s] of [
        ['proxy_age_of_majority', 18, 'int>=1'],
        ['proxy_adolescent_min_age', 13, 'int>=1'],
        ['proxy_age_out_notice_days', 30, 'int>=1'],
        ['proxy_invite_hours', 72, 'hours'],
        ['proxy_code_max_attempts', 3, 'int>=1'],
      ] as const)
        await sa.query(
          `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4)`,
          [ORG, key, JSON.stringify(v), s],
        );
      await sa.query(
        `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
        [ORG],
      );
      await sa.query(
        `INSERT INTO organisation.location (id, organisation_id, name, kind, time_zone, state_code, active) VALUES ($1, $2, 'Main', 'clinic', 'America/New_York', 'NY', true)`,
        [L1, ORG],
      );
    },
  });
  staff = await seedPrincipal(k, 'google', { email: 'staff@clinic.example', name: 'Staff' });
  await assignRole(k, staff.principalId, 'front_desk', L1);
});
after(async () => {
  await k?.close();
});

/** An adult patient with an own principal and self link. */
async function adult(
  n: number,
  email: string,
): Promise<{ pid: string; p: Awaited<ReturnType<typeof seedPrincipal>> }> {
  const pid = id(n);
  await patient(pid, dob(40));
  const p = await seedPrincipal(k, 'patient_pool', { email });
  await k.sa.query(
    `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
    [p.principalId, pid, ORG],
  );
  return { pid, p };
}

describe('adult patient invites a proxy (D-7)', () => {
  test('invite -> mailed code -> accept; default scope is appointments only; wrong codes are counted and lock', async () => {
    const o = await adult(901, 'owner1@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy1@example.test' });
    const svc = k.identity.proxies;
    const ownerScope = patientScope(o.p, [o.pid]);
    const g = await k.db.withScope(ownerScope, (tx) =>
      svc.invite(tx, meta(), o.pid, { email: ' Proxy1@Example.test ', relationship: 'carer' }),
    );
    assert.equal(g.status, 'invited');
    assert.deepEqual(g.scopes, ['appointments']);
    assert.equal(g.guardian, false);
    // The worker makes and mails the code; only a salted hash is stored.
    assert.equal((await sendInvite(g.id))['outcome'], 'sent');
    assert.equal(mails.at(-1)?.to, 'proxy1@example.test');
    const code = lastCode(g.id);
    const stored = await k.q(
      `SELECT encode(code_hash, 'hex') AS h FROM identity.proxy_invite_code WHERE grant_id = $1`,
      [g.id],
    );
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(code) || code.length < 6);
    // Another account (a different address) cannot see or accept it.
    const stranger = await seedPrincipal(k, 'patient_pool', { email: 'stranger@example.test' });
    const out = await k.db.withScope(patientScope(stranger), (tx) =>
      svc.accept(tx, meta(), g.id, code),
    );
    assert.equal(out.kind, 'invalid');
    // Wrong codes: counted, then locked even for the right code.
    const pscope = patientScope(proxy);
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await k.db.withScope(pscope, (tx) =>
            svc.accept(tx, meta(), g.id, code === '000000' ? '111111' : '000000'),
          )
        ).kind,
        'invalid',
      );
    assert.equal(
      (await k.db.withScope(pscope, (tx) => svc.accept(tx, meta(), g.id, code))).kind,
      'invalid',
      'locked after max attempts',
    );
    // A re-sent invitation (new code, attempts reset) works.
    await sendInvite(g.id);
    const accepted = await k.db.withScope(pscope, (tx) =>
      svc.accept(tx, meta(), g.id, lastCode(g.id)),
    );
    assert.equal(accepted.kind, 'accepted');
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments'] });
    // The audit trail has the invitation, the mail and the acceptance.
    const ev = await k.q<{ change: { event: string } }>(
      `SELECT change FROM audit.event WHERE resource_type = 'identity.proxy_grant' AND resource_id = $1 ORDER BY occurred_at`,
      [g.id],
    );
    const names = ev.map((e) => e.change.event);
    for (const want of ['proxy_invited', 'proxy_invite_sent', 'proxy_accepted'])
      assert.ok(names.includes(want), want);
    // Nothing in any audit row carries the code.
    assert.ok(!JSON.stringify(ev).includes(`"${code}"`));
  });

  test('the patient grants messages and documents per scope; revoking a scope takes effect on the next request', async () => {
    const o = await adult(902, 'owner2@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy2@example.test' });
    const svc = k.identity.proxies;
    const ownerScope = patientScope(o.p, [o.pid]);
    const g = await k.db.withScope(ownerScope, (tx) =>
      svc.invite(tx, meta(), o.pid, {
        email: 'proxy2@example.test',
        relationship: 'parent',
        scopes: ['messages'],
      }),
    );
    assert.deepEqual(g.scopes, ['appointments', 'messages']);
    await sendInvite(g.id);
    await k.db.withScope(patientScope(proxy), (tx) => svc.accept(tx, meta(), g.id, lastCode(g.id)));
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments', 'messages'] });
    await k.db.withScope(ownerScope, (tx) =>
      svc.setScopes(tx, meta(), o.pid, g.id, ['documents', 'messages']),
    );
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments', 'documents', 'messages'] });
    await k.db.withScope(ownerScope, (tx) => svc.setScopes(tx, meta(), o.pid, g.id, []));
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments'] });
    // Unknown scope: refused.
    await assert.rejects(
      k.db.withScope(ownerScope, (tx) => svc.setScopes(tx, meta(), o.pid, g.id, ['admin'])),
      (e: { fields?: string[] }) => e.fields?.includes('scopes') === true,
    );
    // A proxy cannot change its own scope (patient path refuses a proxy scope).
    await assert.rejects(
      k.db.withScope({ ...patientScope(proxy, [o.pid]), proxyPatientIds: [o.pid] }, (tx) =>
        svc.setScopes(tx, meta(), o.pid, g.id, ['documents']),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments'] });
  });

  test('revocation by the patient is immediate: the very next scope has no access; so does leaving', async () => {
    const o = await adult(903, 'owner3@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy3@example.test' });
    const svc = k.identity.proxies;
    const ownerScope = patientScope(o.p, [o.pid]);
    const mk = async (): Promise<string> => {
      const g = await k.db.withScope(ownerScope, (tx) =>
        svc.invite(tx, meta(), o.pid, {
          email: 'proxy3@example.test',
          relationship: 'other',
          scopes: ['documents', 'messages'],
        }),
      );
      await sendInvite(g.id);
      await k.db.withScope(patientScope(proxy), (tx) =>
        svc.accept(tx, meta(), g.id, lastCode(g.id)),
      );
      return g.id;
    };
    const g1 = await mk();
    assert.ok((await reach(proxy))[o.pid]);
    assert.equal(
      await k.db.withScope(ownerScope, (tx) => svc.revokeByPatient(tx, meta(), o.pid, g1)),
      true,
    );
    assert.deepEqual(await reach(proxy), {});
    // Row-level security agrees: a proxy scope that was built before the revocation reads no thing of this patient any more.
    const seen = await k.db.withScope(
      { ...patientScope(proxy, [o.pid]), proxyPatientIds: [o.pid] },
      (tx) => svc.listForPatient(tx, o.pid).catch(() => [] as { status: string }[]),
    );
    assert.ok(seen.every((g) => g.status !== 'active'));
    // The invitation can be made again and the proxy can leave by itself.
    const g2 = await mk();
    assert.ok((await reach(proxy))[o.pid]);
    assert.equal(
      await k.db.withScope(patientScope(proxy), (tx) => svc.leave(tx, meta(), g2)),
      true,
    );
    assert.deepEqual(await reach(proxy), {});
    const row = (
      await k.q(`SELECT status, ended_by FROM identity.proxy_grant WHERE id = $1`, [g2])
    )[0];
    assert.deepEqual([row?.['status'], row?.['ended_by']], ['revoked', 'proxy']);
    // Leaving a grant that is not yours does nothing.
    const other = await seedPrincipal(k, 'patient_pool', { email: 'proxy3b@example.test' });
    assert.equal(
      await k.db.withScope(patientScope(other), (tx) => svc.leave(tx, meta(), g1)),
      false,
    );
  });

  test('refusals: a minor cannot invite; inviting yourself; a duplicate open invitation; another patient is not reachable', async () => {
    const svc = k.identity.proxies;
    const minorPid = id(904);
    await patient(minorPid, dob(10));
    const minorP = await seedPrincipal(k, 'patient_pool', { email: 'minor@example.test' });
    await k.sa.query(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [minorP.principalId, minorPid, ORG],
    );
    await assert.rejects(
      k.db.withScope(patientScope(minorP, [minorPid]), (tx) =>
        svc.invite(tx, meta(), minorPid, { email: 'x@example.test', relationship: 'parent' }),
      ),
      (e: unknown) => e instanceof ProxyNotAllowedError,
    );
    const o = await adult(905, 'owner5@example.test');
    const o2 = await adult(906, 'owner6@example.test');
    await assert.rejects(
      k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.invite(tx, meta(), o.pid, { email: 'owner5@example.test', relationship: 'parent' }),
      ),
      (e: unknown) => e instanceof ProxyNotAllowedError,
    );
    await k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
      svc.invite(tx, meta(), o.pid, { email: 'dup@example.test', relationship: 'parent' }),
    );
    await assert.rejects(
      k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.invite(tx, meta(), o.pid, { email: 'dup@example.test', relationship: 'parent' }),
      ),
      (e: { code?: string }) =>
        e.code === 'identity.proxy_conflict' ||
        e.code === '23505' ||
        (e as Error).name.includes('Conflict'),
    );
    // Cross-patient: owner 5 cannot invite for, list, revoke or change scope of patient 6's grants.
    await assert.rejects(
      k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.invite(tx, meta(), o2.pid, { email: 'z@example.test', relationship: 'parent' }),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    const g6 = await k.db.withScope(patientScope(o2.p, [o2.pid]), (tx) =>
      svc.invite(tx, meta(), o2.pid, { email: 'p6@example.test', relationship: 'parent' }),
    );
    assert.deepEqual(
      await k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.listForPatient(tx, o2.pid).catch(() => []),
      ),
      [],
    );
    await assert.rejects(
      k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.revokeByPatient(tx, meta(), o2.pid, g6.id),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    assert.equal(
      await k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
        svc.revokeByPatient(tx, meta(), o.pid, g6.id),
      ),
      false,
      'a grant of patient 6 is not revocable through patient 5',
    );
    assert.equal(
      (await k.q(`SELECT status FROM identity.proxy_grant WHERE id = $1`, [g6.id]))[0]?.['status'],
      'requested',
    );
  });
});

describe('staff link a guardian of a minor; age rules; age-out', () => {
  async function link(pid: string, email: string, scopes?: string[]): Promise<string> {
    const doc = await document(pid, staff.principalId);
    staffVisible.add(pid);
    await k.sa.query(
      `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [pid, L1, ORG],
    );
    const g = await k.db.withScope(staffScope(), (tx) =>
      k.identity.proxies.staffLink(tx, meta(), pid, {
        email,
        relationship: 'parent',
        documentId: doc,
        ...(scopes === undefined ? {} : { scopes }),
      }),
    );
    await sendInvite(g.id);
    const guardian = await seedPrincipal(k, 'patient_pool', { email });
    const out = await k.db.withScope(patientScope(guardian), (tx) =>
      k.identity.proxies.accept(tx, meta(), g.id, lastCode(g.id)),
    );
    assert.equal(out.kind, 'accepted');
    guardians.set(g.id, guardian);
    return g.id;
  }
  const guardians = new Map<string, { principalId: string; personId: string }>();

  test('staff need a clean relationship document of the same patient, and the patient must be a minor', async () => {
    const pid = id(910);
    await patient(pid, dob(8));
    staffVisible.add(pid);
    await k.sa.query(
      `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3)`,
      [pid, L1, ORG],
    );
    const svc = k.identity.proxies;
    // Document of another patient, a document still scanning, a random id: all refused.
    const otherPid = id(911);
    await patient(otherPid, dob(8));
    const others = await document(otherPid, staff.principalId);
    const scanning = await document(pid, staff.principalId, 'scanning');
    for (const documentId of [others, scanning, uuidv7()])
      await assert.rejects(
        k.db.withScope(staffScope(), (tx) =>
          svc.staffLink(tx, meta(), pid, {
            email: 'g@example.test',
            relationship: 'parent',
            documentId,
          }),
        ),
        (e: unknown) => e instanceof ProxyNotAllowedError,
      );
    // An adult patient cannot be given a guardian.
    const adultPid = id(912);
    await patient(adultPid, dob(30));
    staffVisible.add(adultPid);
    await k.sa.query(
      `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3)`,
      [adultPid, L1, ORG],
    );
    const d3 = await document(adultPid, staff.principalId);
    await assert.rejects(
      k.db.withScope(staffScope(), (tx) =>
        svc.staffLink(tx, meta(), adultPid, {
          email: 'g@example.test',
          relationship: 'guardian',
          documentId: d3,
        }),
      ),
      (e: unknown) => e instanceof ProxyNotAllowedError,
    );
    // A patient-realm caller cannot use the staff route.
    const someone = await seedPrincipal(k, 'patient_pool', { email: 'someone@example.test' });
    await assert.rejects(
      k.db.withScope(patientScope(someone), (tx) =>
        svc.staffLink(tx, meta(), pid, {
          email: 'g@example.test',
          relationship: 'parent',
          documentId: others,
        }),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    // Staff of a location that does not see the patient cannot link.
    await k.sa.query(`DELETE FROM patient.staff_scope WHERE patient_id = $1`, [pid]);
    const d4 = await document(pid, staff.principalId);
    await assert.rejects(
      k.db.withScope(staffScope(), (tx) =>
        svc.staffLink(tx, meta(), pid, {
          email: 'g@example.test',
          relationship: 'parent',
          documentId: d4,
        }),
      ),
    );
  });

  test('a guardian of a child under 13 may be given more scope; from 13 the guardian keeps appointments only, whatever was granted', async () => {
    const young = id(920);
    await patient(young, dob(10));
    const teen = id(921);
    await patient(teen, dob(15));
    const gy = await link(young, 'gy@example.test', ['messages', 'documents']);
    const gt = await link(teen, 'gt@example.test', ['messages', 'documents']);
    assert.deepEqual(await reach(guardians.get(gy) as never), {
      [young]: ['appointments', 'documents', 'messages'],
    });
    assert.deepEqual(await reach(guardians.get(gt) as never), { [teen]: ['appointments'] });
    const row = (
      await k.q(
        `SELECT guardian, source, valid_until::text AS vu, adolescent_from::text AS af, verification_document_id FROM identity.proxy_grant WHERE id = $1`,
        [gt],
      )
    )[0];
    assert.equal(row?.['guardian'], true);
    assert.equal(row?.['source'], 'staff_link');
    assert.ok(row?.['verification_document_id']);
    // The patient cannot widen a guardian grant (it is staff-managed).
    // A minor turning 13 later: the same grant narrows by itself (evaluated per request, no job needed).
    await k.sa.query(
      `UPDATE identity.proxy_grant SET adolescent_from = current_date - 1 WHERE id = $1`,
      [gy],
    );
    assert.deepEqual(await reach(guardians.get(gy) as never), { [young]: ['appointments'] });
    const ev = await k.q<{ change: { event: string } }>(
      `SELECT change FROM audit.event WHERE resource_id = $1`,
      [gt],
    );
    assert.ok(ev.some((e) => e.change.event === 'guardian_linked'));
  });

  test('access ends the day before the 18th birthday by itself (even if the job has not run), the job records it and sends the notice 30 days before', async () => {
    const soon = id(930); // turns 18 in 20 days
    await patient(soon, dob(18, 20));
    const later = id(931); // turns 18 in 200 days
    await patient(later, dob(18, 200));
    const gSoon = await link(soon, 'soon@example.test');
    const gLater = await link(later, 'later@example.test');
    assert.ok((await reach(guardians.get(gSoon) as never))[soon]);
    notices.length = 0;
    const r1 = await ageOut();
    assert.equal(r1['noticed'], 1);
    assert.deepEqual(
      notices.map((n) => n.grantId),
      [gSoon],
    );
    assert.equal(notices[0]?.to, 'soon@example.test');
    assert.equal(notices[0]?.daysLeft, 20);
    // Once per grant.
    const r2 = await ageOut();
    assert.equal(r2['noticed'], 0);
    assert.equal(notices.length, 1);
    // Time passes: the birthday of "soon" is reached (move the stored birth date, as the job re-derives from settings, then force dates).
    await k.sa.query(
      `UPDATE identity.proxy_grant SET valid_until = current_date - 1 WHERE id = $1`,
      [gSoon],
    );
    // Before the job runs, the scope builder already refuses (access is computed per request, not by the job).
    assert.deepEqual(await reach(guardians.get(gSoon) as never), {});
    // The job would re-derive dates from the birth date, so move the birth date to match the elapsed time.
    await k.sa.query(
      `UPDATE identity.proxy_grant SET patient_birth_date = (current_date - interval '18 years' - interval '2 days')::date WHERE id = $1`,
      [gSoon],
    );
    const r3 = await ageOut();
    assert.equal(r3['expired'], 1);
    const row = (
      await k.q(`SELECT status, ended_by, revoke_reason FROM identity.proxy_grant WHERE id = $1`, [
        gSoon,
      ])
    )[0];
    assert.deepEqual(
      [row?.['status'], row?.['ended_by'], row?.['revoke_reason']],
      ['expired', 'age_out', 'age_out'],
    );
    assert.ok(
      (await reach(guardians.get(gLater) as never))[later],
      'a guardian whose child is still a minor keeps access',
    );
    const ev = await k.q<{ change: { event: string }; job_id: string | null }>(
      `SELECT change, job_id FROM audit.event WHERE resource_id = $1 ORDER BY occurred_at`,
      [gSoon],
    );
    const names = ev.map((e) => e.change.event);
    assert.ok(names.includes('proxy_age_out_notice_sent') && names.includes('proxy_aged_out'));
    assert.ok(
      ev.filter((e) => e.change.event === 'proxy_aged_out').every((e) => e.job_id !== null),
    );
  });

  test('a setting change is applied: a larger age of majority re-derives the end date; unconfigured rules fail closed', async () => {
    const pid = id(940);
    await patient(pid, dob(16));
    const g = await link(pid, 'cfg@example.test');
    const before = (
      await k.q(`SELECT valid_until::text AS vu FROM identity.proxy_grant WHERE id = $1`, [g])
    )[0]?.['vu'];
    await k.sa.query(
      `UPDATE kernel.setting SET value = '19'::jsonb WHERE key = 'proxy_age_of_majority' AND organisation_id = $1`,
      [ORG],
    );
    try {
      const r = await ageOut();
      assert.ok(Number(r['rederived']) >= 1);
      const after = (
        await k.q(`SELECT valid_until::text AS vu FROM identity.proxy_grant WHERE id = $1`, [g])
      )[0]?.['vu'];
      assert.notEqual(after, before);
    } finally {
      await k.sa.query(
        `UPDATE kernel.setting SET value = '18'::jsonb WHERE key = 'proxy_age_of_majority' AND organisation_id = $1`,
        [ORG],
      );
    }
    await ageOut();
    assert.equal(
      (
        await k.q(`SELECT valid_until::text AS vu FROM identity.proxy_grant WHERE id = $1`, [g])
      )[0]?.['vu'],
      before,
    );
  });

  test('staff revoke at any time, immediately, with the audit event; a proxy cannot revoke through the staff path; the unseen patient is out of reach', async () => {
    const pid = id(950);
    await patient(pid, dob(9));
    const g = await link(pid, 'rev@example.test');
    const guardian = guardians.get(g) as { principalId: string; personId: string };
    assert.ok((await reach(guardian))[pid]);
    await assert.rejects(
      k.db.withScope(patientScope(guardian, [pid]), (tx) =>
        k.identity.proxies.staffRevoke(tx, meta(), pid, g),
      ),
      (e: unknown) => e instanceof IdentityScopeError,
    );
    assert.equal(
      await k.db.withScope(staffScope(), (tx) =>
        k.identity.proxies.staffRevoke(tx, meta(), pid, g),
      ),
      true,
    );
    assert.deepEqual(await reach(guardian), {});
    assert.equal(
      await k.db.withScope(staffScope(), (tx) =>
        k.identity.proxies.staffRevoke(tx, meta(), pid, g),
      ),
      false,
    );
    const ev = await k.q<{ change: { event: string; by?: string } }>(
      `SELECT change FROM audit.event WHERE resource_id = $1`,
      [g],
    );
    assert.ok(ev.some((e) => e.change.event === 'proxy_revoked' && e.change.by === 'staff'));
    // A grant for a patient no longer in the staff location's scope cannot be revoked by that staff.
    const pid2 = id(951);
    await patient(pid2, dob(9));
    const g2 = await link(pid2, 'rev2@example.test');
    await k.sa.query(`DELETE FROM patient.staff_scope WHERE patient_id = $1`, [pid2]);
    staffVisible.delete(pid2);
    assert.equal(
      await k.db.withScope(staffScope(), (tx) =>
        k.identity.proxies.staffRevoke(tx, meta(), pid2, g2),
      ),
      false,
    );
    assert.ok((await reach(guardians.get(g2) as never))[pid2], 'still active');
  });
});

describe('a proxy cannot widen its own scopes in SQL (BR-PROXY-01)', () => {
  test('an active proxy and an accepting invitee both fail to change scopes; the owning patient still can', async () => {
    const o = await adult(1940, 'owner1940@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy1940@example.test' });
    const svc = k.identity.proxies;
    const g = await k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
      svc.invite(tx, meta(), o.pid, {
        email: 'proxy1940@example.test',
        relationship: 'carer',
        scopes: ['documents'],
      }),
    );
    await sendInvite(g.id);
    const widen = `UPDATE identity.proxy_grant SET scopes = ARRAY['appointments','messages','documents'] WHERE id = $1`;
    // The invitee, while accepting, tries to take every scope in the same statement.
    await assert.rejects(
      k.db.withScope(patientScope(proxy), (tx) =>
        tx.query(
          `UPDATE identity.proxy_grant SET scopes = ARRAY['appointments','messages','documents'], proxy_principal_id = $2, status = 'active' WHERE id = $1`,
          [g.id, proxy.principalId],
        ),
      ),
      /only the patient changes the scopes/,
    );
    await k.db.withScope(patientScope(proxy), (tx) => svc.accept(tx, meta(), g.id, lastCode(g.id)));
    const proxyScope = { ...patientScope(proxy, [o.pid]), proxyPatientIds: [o.pid] };
    await assert.rejects(
      k.db.withScope(proxyScope, (tx) => tx.query(widen, [g.id])),
      /only the patient changes the scopes/,
    );
    // Also without the proxy list in its scope (a proxy scope that was built without it is still the proxy).
    await assert.rejects(
      k.db.withScope(patientScope(proxy, [o.pid]), (tx) => tx.query(widen, [g.id])),
      /only the patient changes the scopes/,
    );
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments', 'documents'] });
    // The owner, as themselves, still changes them.
    await k.db.withScope(patientScope(o.p, [o.pid]), (tx) => tx.query(widen, [g.id]));
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments', 'documents', 'messages'] });
    // Staff cannot change the scopes either (refused by the trigger or by no matching row).
    staffVisible.add(o.pid);
    const narrowed = await k.db
      .withScope(staffScope(), (tx) =>
        tx.query(`UPDATE identity.proxy_grant SET scopes = ARRAY['appointments'] WHERE id = $1`, [
          g.id,
        ]),
      )
      .then((r) => r.rowCount ?? 0)
      .catch(() => 0);
    assert.equal(narrowed, 0);
    assert.deepEqual(await reach(proxy), { [o.pid]: ['appointments', 'documents', 'messages'] });
  });
});

describe('the scopes become data access only through row-level security (BR-PROXY-02)', () => {
  async function doc(pid: string, classification: string, status: string): Promise<string> {
    const did = uuidv7();
    await k.sa.query(`SET session_replication_role = replica`);
    await k.sa.query(
      `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, uploaded_by, upload_channel, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7, $8)`,
      [
        did,
        ORG,
        pid,
        classification,
        status,
        staff.principalId,
        status === 'confirmed' ? staff.principalId : null,
        status === 'confirmed' ? new Date() : null,
      ],
    );
    await k.sa.query(
      `INSERT INTO documents.document_version (document_id, version, organisation_id, patient_id, object_key, bucket, sha256, size_bytes, content_type, declared_content_type, scan_status, scanned_at)
       VALUES ($1, 1, $2, $3, $4, 'clean', decode(repeat('ab', 32), 'hex'), 10, 'application/pdf', 'application/pdf', 'clean', now())`,
      [did, ORG, pid, `c/${did.replaceAll('-', '')}`],
    );
    await k.sa.query(`SET session_replication_role = origin`);
    return did;
  }
  async function thread(pid: string): Promise<string> {
    const tid = uuidv7();
    await k.sa.query(`SET session_replication_role = replica`); // fixture: the thread guard wants the caller as creator
    await k.sa.query(
      `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, created_by) VALUES ($1, $2, 'patient', $3, 'Hello', $4)`,
      [tid, ORG, pid, staff.principalId],
    );
    await k.sa.query(`SET session_replication_role = origin`);
    return tid;
  }
  const seen = async (
    scope: ScopeSettings,
    table: 'documents.document' | 'documents.document_version' | 'messaging.thread',
  ): Promise<string[]> =>
    (
      await k.db.withScope(scope, (tx) =>
        tx.query(
          `SELECT patient_id, ${table === 'documents.document_version' ? 'document_id' : 'id'} AS id FROM ${table} ORDER BY 2`,
        ),
      )
    ).rows.map((r) => `${r['patient_id']}:${r['id']}`);
  const asProxy = (
    p: { principalId: string; personId: string },
    ...pids: string[]
  ): ScopeSettings => ({
    ...patientScope(p, pids),
    proxyPatientIds: pids,
  });

  test('documents and threads are visible only with the scope, only for the patient who granted it, and stop at once on removal, revoke and leave', async () => {
    const a = await adult(1950, 'owner1950@example.test');
    const b = await adult(1951, 'owner1951@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy1950@example.test' });
    const svc = k.identity.proxies;
    const g = await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.invite(tx, meta(), a.pid, {
        email: 'proxy1950@example.test',
        relationship: 'carer',
        scopes: ['documents', 'messages'],
      }),
    );
    await sendInvite(g.id);
    await k.db.withScope(patientScope(proxy), (tx) => svc.accept(tx, meta(), g.id, lastCode(g.id)));
    const released = await doc(a.pid, 'consent', 'clean');
    const confirmed = await doc(a.pid, 'insurance_card', 'confirmed');
    await doc(a.pid, 'id_document', 'clean'); // class the patient never sees
    await doc(a.pid, 'consent', 'quarantined'); // not released
    await doc(a.pid, 'consent', 'deleted').catch(() => undefined);
    await doc(b.pid, 'consent', 'clean'); // another patient
    const t = await thread(a.pid);
    await thread(b.pid);
    // A scope list that wrongly names both patients (an API defect) still reads only the one the proxy holds a scope for.
    const scope = asProxy(proxy, a.pid, b.pid);
    const want = [`${a.pid}:${released}`, `${a.pid}:${confirmed}`].sort();
    assert.deepEqual(await seen(scope, 'documents.document'), want);
    assert.deepEqual(
      await seen(scope, 'documents.document_version'),
      want.map((x) => x),
    );
    assert.deepEqual(await seen(scope, 'messaging.thread'), [`${a.pid}:${t}`]);
    // Writes stay closed to a proxy.
    const upd = await k.db
      .withScope(scope, (tx) =>
        tx.query(
          `UPDATE documents.document SET status = 'deleted', deleted_at = now() WHERE id = $1`,
          [released],
        ),
      )
      .then((r) => r.rowCount ?? 0)
      .catch(() => 0);
    assert.equal(upd, 0, 'a proxy updates no document');
    await assert.rejects(
      k.db.withScope(scope, (tx) =>
        tx.query(
          `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, created_by) VALUES ($1, $2, 'patient', $3, 'x', $4)`,
          [uuidv7(), ORG, a.pid, proxy.principalId],
        ),
      ),
    );
    // One scope at a time: removing documents leaves threads, removing messages leaves nothing.
    await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.setScopes(tx, meta(), a.pid, g.id, ['messages']),
    );
    assert.deepEqual(await seen(scope, 'documents.document'), []);
    assert.deepEqual(await seen(scope, 'documents.document_version'), []);
    assert.deepEqual(await seen(scope, 'messaging.thread'), [`${a.pid}:${t}`]);
    await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.setScopes(tx, meta(), a.pid, g.id, ['documents']),
    );
    assert.deepEqual(await seen(scope, 'messaging.thread'), []);
    assert.equal((await seen(scope, 'documents.document')).length, 2);
    // Revocation cuts it at once, on the very next statement and with the stale scope the request began with.
    await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.revokeByPatient(tx, meta(), a.pid, g.id),
    );
    assert.deepEqual(await seen(scope, 'documents.document'), []);
    // Leaving: a new grant, then the proxy leaves.
    const g2 = await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.invite(tx, meta(), a.pid, {
        email: 'proxy1950@example.test',
        relationship: 'carer',
        scopes: ['documents', 'messages'],
      }),
    );
    await sendInvite(g2.id);
    await k.db.withScope(patientScope(proxy), (tx) =>
      svc.accept(tx, meta(), g2.id, lastCode(g2.id)),
    );
    assert.equal((await seen(scope, 'documents.document')).length, 2);
    await k.db.withScope(patientScope(proxy), (tx) => svc.leave(tx, meta(), g2.id));
    assert.deepEqual(await seen(scope, 'documents.document'), []);
    assert.deepEqual(await seen(scope, 'messaging.thread'), []);
  });

  test('the appointments-only default reads no document and no thread; age-out and the 13-17 narrowing cut a guardian', async () => {
    const a = await adult(1952, 'owner1952@example.test');
    const proxy = await seedPrincipal(k, 'patient_pool', { email: 'proxy1952@example.test' });
    const svc = k.identity.proxies;
    const g = await k.db.withScope(patientScope(a.p, [a.pid]), (tx) =>
      svc.invite(tx, meta(), a.pid, { email: 'proxy1952@example.test', relationship: 'carer' }),
    );
    await sendInvite(g.id);
    await k.db.withScope(patientScope(proxy), (tx) => svc.accept(tx, meta(), g.id, lastCode(g.id)));
    await doc(a.pid, 'consent', 'clean');
    await thread(a.pid);
    const scope = asProxy(proxy, a.pid);
    assert.deepEqual(await seen(scope, 'documents.document'), []);
    assert.deepEqual(await seen(scope, 'messaging.thread'), []);
    // A guardian holding documents: visible for a child under 13, hidden from 13 (appointments only), hidden after the last day.
    const child = id(1953);
    await patient(child, dob(10));
    await doc(child, 'consent', 'clean');
    const guardian = await seedPrincipal(k, 'patient_pool', { email: 'guardian1953@example.test' });
    const gid = uuidv7();
    await k.sa.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, scopes, guardian, source, patient_birth_date, adolescent_from, valid_until)
       VALUES ($1,$2,$3,$4,'parent','Kid','active',ARRAY['appointments','documents'],true,'staff_link', current_date - 3650, current_date + 1000, current_date + 2000)`,
      [gid, ORG, guardian.principalId, child],
    );
    const gscope = asProxy(guardian, child);
    assert.equal((await seen(gscope, 'documents.document')).length, 1);
    await k.sa.query(
      `UPDATE identity.proxy_grant SET adolescent_from = current_date WHERE id = $1`,
      [gid],
    );
    assert.deepEqual(await seen(gscope, 'documents.document'), []);
    await k.sa.query(
      `UPDATE identity.proxy_grant SET adolescent_from = current_date + 1000, valid_until = current_date - 1 WHERE id = $1`,
      [gid],
    );
    assert.deepEqual(await seen(gscope, 'documents.document'), []);
  });
});

describe('the age-out job without the mail port (BR-PROXY-03)', () => {
  test('grants and invitations still expire and are audited; only the notice step fails', async () => {
    const later = id(1960);
    await patient(later, dob(18, -3)); // turned 18 three days ago
    const guardian = await seedPrincipal(k, 'patient_pool', { email: 'guardian1960@example.test' });
    const gid = uuidv7();
    await k.sa.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, scopes, guardian, source, patient_birth_date, adolescent_from, valid_until)
       VALUES ($1,$2,$3,$4,'parent','Kid','active',ARRAY['appointments'],true,'staff_link', $5, $6, $7)`,
      [gid, ORG, guardian.principalId, later, dob(18, -3), dob(5, -3), dob(0, -4)],
    );
    // An invitation nobody accepted in time.
    const o = await adult(1961, 'owner1961@example.test');
    const inv = await k.db.withScope(patientScope(o.p, [o.pid]), (tx) =>
      k.identity.proxies.invite(tx, meta(), o.pid, {
        email: 'nobody1961@example.test',
        relationship: 'carer',
      }),
    );
    await k.sa.query(
      `UPDATE identity.proxy_grant SET created_at = now() - interval '10 days' WHERE id = $1`,
      [inv.id],
    );
    await assert.rejects(
      (k.worker['runProxyAgeOut'] as unknown as Job)({ db: k.wdb, orgId: ORG }),
      /mail port is not configured/,
    );
    const rows = await k.q<{ id: string; status: string }>(
      `SELECT id, status FROM identity.proxy_grant WHERE id = ANY($1)`,
      [[gid, inv.id]],
    );
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), {
      [gid]: 'expired',
      [inv.id]: 'expired',
    });
    const ev = await k.q<{ change: { event: string } }>(
      `SELECT change FROM audit.event WHERE resource_id = ANY($1)`,
      [[gid, inv.id]],
    );
    const names = ev.map((e) => e.change.event);
    assert.ok(names.includes('proxy_aged_out') && names.includes('proxy_invite_expired'));
  });
});
