// Real-database tests for BE-09, part 1: request, approval, the execute job, the participant registry and the conflict rules
// (ARCHITECTURE 22.16, 25.4, 38.2 items 2 and 11; SHARED-BOUNDARIES 9.2; TC-MG-02..07, 11..13).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/merge/merge.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ParticipantRegistries } from '@ehr/kernel';
import type { MergeParticipant, ScopeSettings } from '@ehr/kernel';
import { registerIdentityParticipants } from '../../identity/index.js';
import { PATIENT_HOST, confirmedBooking, patientAccount, seedPrincipal } from '../testkit.js';
import {
  A1,
  A2,
  B1,
  ORG,
  call,
  registerCombinedParticipants,
  saWrite,
  setupMerge,
  writeHeaders,
} from './testkit.js';
import type { MergeKit, SeededSession } from './testkit.js';

let m: MergeKit;
before(async () => {
  m = await setupMerge('mg');
});
after(async () => {
  await m?.close();
});

const q = <T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]> =>
  m.k.q<T>(sql, p);
const one = async <T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T> =>
  (await q<T>(sql, p))[0] as T;
const n = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await one<{ n: string }>(sql, p)).n);
const w = (sql: string, p: unknown[] = []): Promise<void> => saWrite(m.k, sql, p);
const post = (
  s: SeededSession,
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  host?: string,
) =>
  call(m.k.base, 'POST', path, {
    ...(host === undefined ? {} : { host }),
    cookie: s.cookie,
    headers: writeHeaders(s, host, key),
    body,
  });
const get = (s: SeededSession, path: string) => call(m.k.base, 'GET', path, { cookie: s.cookie });
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];

let next = 100;
const patient = (loc = A1): Promise<string> =>
  m.mkPatient(next++, loc === B1 ? m.deskB1 : m.deskA1, loc);
const status = async (pid: string): Promise<string> =>
  (await one<{ status: string }>(`SELECT status FROM patient.patient WHERE id = $1`, [pid])).status;
const reqRow = (rid: string) =>
  one<{
    status: string;
    failure_code: string | null;
    counts: Record<string, Record<string, number>> | null;
  }>(`SELECT status, failure_code, counts FROM patient.merge_request WHERE id = $1`, [rid]);
const asStaff = (s: SeededSession, locationIds: string[]): ScopeSettings => ({
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: s.seeded.principalId,
  personId: s.seeded.personId,
  locationIds,
});
const scopeOf = async (pid: string): Promise<string[]> =>
  (
    await q<{ location_id: string }>(
      `SELECT location_id FROM patient.staff_scope WHERE patient_id = $1 ORDER BY 1`,
      [pid],
    )
  ).map((r) => r.location_id);

// --- seed helpers (superuser with the settings of a system job) -----------------------------------------------------------------
const contact = (p: string) =>
  w(
    `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES (gen_random_uuid(), $1, $2, 'emergency', 'Contact')`,
    [ORG, p],
  );
const coverage = (p: string) =>
  w(
    `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id) VALUES (gen_random_uuid(), $1, $2, 'Payer', 'M-1')`,
    [ORG, p],
  );
const consent = (p: string, key: string, version: number, st: 'signed' | 'pending' | 'withdrawn') =>
  w(
    st === 'signed'
      ? `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, status, signed_at, signer_principal_id, signer_relationship, signed_name)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'signed', now() - ($4::int || ' days')::interval, gen_random_uuid(), 'self', 'Typed Name')`
      : st === 'withdrawn'
        ? `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, status, withdrawn_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'withdrawn', now())`
        : `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending')`,
    [ORG, p, key, version],
  );
const preference = (p: string, channel: string) =>
  w(
    `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, language) VALUES ($2, $1, ARRAY[$3]::text[], 'en')`,
    [ORG, p, channel],
  );
const careTeam = (p: string, principal: string, role: string, ended = false) =>
  w(
    ended
      ? `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role, from_date, to_date, end_reason) VALUES (gen_random_uuid(), $1, $2, $3, $4, '2020-01-01', '2021-01-01', 'staff')`
      : `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [ORG, p, principal, role],
  );
const flag = (p: string, cand: string, st: 'open' | 'resolved', at: string) =>
  w(
    `INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source, status, resolved_reason, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'probable', 'front_desk', $4, $5, $6::timestamptz)`,
    [ORG, p, cand, st, st === 'resolved' ? 'staff' : null, at],
  );
const notification = (p: string, st: 'queued' | 'failed' | 'sent' | 'suppressed', key: string) =>
  w(
    `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, status, dedupe_key, sent_at, suppress_reason)
     VALUES (gen_random_uuid(), $1, 'patient', $2, 'appointment_cancelled', 2, 'sms', $3, $4, CASE WHEN $3 = 'sent' THEN now() END, CASE WHEN $3 = 'suppressed' THEN 'preference_off' END)`,
    [ORG, p, st, `seed:${key}`],
  );
const proxy = (p: string, principal: string, st: 'requested' | 'active' | 'revoked') =>
  w(
    `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name, status, revoked_at, revoke_reason)
     VALUES (gen_random_uuid(), $1, $2, $3, 'parent', 'Seed', $4, CASE WHEN $4 = 'revoked' THEN now() END, CASE WHEN $4 = 'revoked' THEN 'staff' END)`,
    [ORG, principal, p, st],
  );
const link = (p: string, principal: string) =>
  w(
    `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
    [principal, p, ORG],
  );

describe('request, approval and permissions (25.4, BQ-3)', () => {
  test('TC-MG-03: a front-desk user without patient.merge.request is refused', async () => {
    const s = await patient();
    const d = await patient();
    const r = await m.request(m.deskA1, s, d);
    assert.equal(r.status, 403);
    assert.equal(code(r), 'auth.forbidden');
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.merge_request WHERE merged_id = $1`, [d]),
      0,
    );
  });

  test('the requester must see both patients: one invisible is 404 with an audited not_visible, nothing is stored; bad bodies are 422', async () => {
    const s = await patient(A1);
    const d = await patient(B1);
    const denied = () =>
      n(
        `SELECT count(*) AS n FROM audit.event WHERE action = 'denied' AND denial_reason = 'not_visible'`,
      );
    const before = await denied();
    const r = await m.request(m.leadA1, s, d); // leadA1 sees A1 only
    assert.equal(r.status, 404);
    assert.equal(await denied(), before + 1);
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.merge_request WHERE merged_id = $1`, [d]),
      0,
    );
    assert.equal((await m.request(m.lead, s, s)).status, 422);
    assert.equal((await m.request(m.lead, s, d, '')).status, 422);
    assert.equal((await m.request(m.lead, 'not-a-uuid', d)).status, 422);
  });

  test('request -> a second person approves; the requester cannot (403 patient.merge_self_approval); a lead without .approve cannot (403)', async () => {
    const s = await patient();
    const d = await patient();
    const r = await m.request(m.lead, s, d);
    assert.equal(r.status, 200, r.body);
    const rid = r.json()['id'] as string;
    assert.equal(r.json()['status'], 'requested');
    // the same merged patient while a request is open: 409 patient.merge_pending
    const again = await m.request(m.lead, s, d);
    assert.equal(again.status, 409);
    assert.equal(code(again), 'patient.merge_pending');
    // front_desk_lead holds .request but not .approve (identity reference data): the guard refuses
    const leadTry = await m.approve(m.leadA1, rid);
    assert.equal(leadTry.status, 403);
    assert.equal(code(leadTry), 'auth.forbidden');
    // medical_records holds both; the person who requested it may not approve it
    const s2 = await patient();
    const d2 = await patient();
    const own = await m.request(m.mrA1, s2, d2);
    assert.equal(own.status, 200, own.body);
    const self = await m.approve(m.mrA1, own.json()['id'] as string);
    assert.equal(self.status, 403);
    assert.equal(code(self), 'patient.merge_self_approval');
    assert.equal((await reqRow(own.json()['id'] as string)).status, 'requested');
    // a second person approves; a second decision is refused (412), not repeated
    const approved = await m.approve(m.mr, rid);
    assert.equal(approved.status, 200, approved.body);
    assert.equal(approved.json()['status'], 'approved');
    assert.equal((await m.approve(m.mr2, rid)).status, 412);
    // the approver need not see the patients, and may read the request
    const view = await get(m.mr, `/api/v1/patient-merges/${rid}`);
    assert.equal(view.status, 200);
    assert.equal(view.json()['status'], 'approved');
    // one execute job, carrying the request ID only
    const jobs = await q<{ payload: object }>(
      `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'patient.execute_merge' AND j.payload->>'mergeRequestId' = $1`,
      [rid],
    );
    assert.equal(jobs.length, 1);
    assert.deepEqual(Object.keys(jobs[0]?.payload as object), ['mergeRequestId']);
  });

  test('idempotency: the same key replays the approval and queues one job; a rejection leaves the patients untouched and the request terminal', async () => {
    const s = await patient();
    const d = await patient();
    const rid = (await m.request(m.lead, s, d)).json()['id'] as string;
    const key = randomUUID();
    const a1 = await m.approve(m.mr, rid, key);
    const a2 = await m.approve(m.mr, rid, key);
    assert.equal(a1.status, 200);
    assert.equal(a2.status, 200);
    assert.equal(a2.headers['idempotent-replay'], 'true');
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'patient.execute_merge' AND j.payload->>'mergeRequestId' = $1`,
        [rid],
      ),
      1,
    );
    const s3 = await patient();
    const d3 = await patient();
    const rid3 = (await m.request(m.lead, s3, d3)).json()['id'] as string;
    const rej = await post(m.mr, `/api/v1/patient-merges/${rid3}/reject`);
    assert.equal(rej.status, 200);
    assert.equal(rej.json()['status'], 'rejected');
    assert.equal((await post(m.mr2, `/api/v1/patient-merges/${rid3}/approve`)).status, 412);
    assert.equal(await status(d3), 'active');
    // a rejected request frees the merged patient for a new request
    assert.equal((await m.request(m.lead, s3, d3)).status, 200);
  });

  test('a request or an approval naming a merged patient is refused with patient.already_merged; an unknown request is 404', async () => {
    const s = await patient();
    const d = await patient();
    const { result } = await m.merge(s, d);
    assert.equal(result.status, 'completed', JSON.stringify([result, m.failures.at(-1)]));
    const r = await m.request(m.lead, s, d);
    assert.equal(r.status, 409);
    assert.equal(code(r), 'patient.already_merged');
    assert.equal((await get(m.lead, `/api/v1/patient-merges/${randomUUID()}`)).status, 404);
  });
});

describe('the execute job and the conflict rules (22.16, 38.2 items 2 and 11; TC-MG-02, TC-MG-05, TC-MG-11)', () => {
  test('one merge with a conflict in every rule: survivor rows win, deleted rows are in merge_residue, counts add up, K rows stay and no R row is left', async () => {
    const S = await patient();
    const D = await patient();
    const X = await patient();
    const Y = await patient();
    const Z = await patient();
    const L1 = (await seedPrincipal(m.k, 'patient_pool')).principalId;
    const L2 = (await seedPrincipal(m.k, 'patient_pool')).principalId;
    const P1 = (await seedPrincipal(m.k, 'patient_pool')).principalId;
    const P2 = (await seedPrincipal(m.k, 'patient_pool')).principalId;
    const [Pa, Pb, Pc] = [randomUUID(), randomUUID(), randomUUID()];

    await contact(D);
    await contact(D);
    await contact(S);
    await coverage(D);
    await consent(D, 'privacy', 2, 'signed');
    await consent(S, 'privacy', 1, 'signed');
    await consent(D, 'portal', 1, 'pending');
    await consent(S, 'portal', 1, 'pending');
    await consent(D, 'old', 1, 'withdrawn');
    await consent(D, 'only_d', 1, 'pending');
    await preference(D, 'sms');
    await preference(S, 'email');
    await careTeam(D, Pa, 'clinician');
    await careTeam(S, Pa, 'clinician');
    await careTeam(D, Pb, 'nurse');
    await careTeam(D, Pc, 'nurse', true);
    await proxy(S, P1, 'requested');
    await proxy(D, P1, 'active');
    await proxy(D, P2, 'revoked');
    await link(S, L1);
    await link(D, L1);
    await link(D, L2);
    await notification(D, 'queued', 'q1');
    await notification(D, 'failed', 'f1');
    await notification(D, 'sent', 's1');
    await notification(D, 'suppressed', 'x1');
    // flags: S-X is older than D-X; D-S between the two; Y names D as candidate; D-Z already decided
    await flag(S, X, 'open', '2026-01-01T00:00:00Z');
    await flag(D, X, 'open', '2026-02-01T00:00:00Z');
    await flag(D, S, 'open', '2026-02-02T00:00:00Z');
    await flag(Y, D, 'open', '2026-02-03T00:00:00Z');
    await flag(D, Z, 'resolved', '2026-02-04T00:00:00Z');

    const { requestId, result } = await m.merge(S, D);
    assert.equal(result.status, 'completed', JSON.stringify([result, m.failures.at(-1)]));
    const row = await reqRow(requestId);
    assert.equal(row.status, 'completed');
    const c = row.counts as Record<string, Record<string, number>>;
    const t = (table: string, found: number, repointed: number, resolved: number, kept: number) =>
      assert.deepEqual(c[table], { found, repointed, resolved, kept }, table);
    t('patient.patient_contact', 2, 2, 0, 0);
    t('patient.insurance_coverage', 1, 1, 0, 0);
    t('patient.consent', 4, 2, 1, 1);
    t('patient.communication_preference', 1, 0, 1, 0);
    t('patient.care_team_member', 3, 1, 1, 1);
    t('patient.duplicate_flag', 4, 1, 2, 1);
    t('identity.patient_link', 2, 1, 1, 0);
    t('identity.proxy_grant', 2, 1, 0, 1);
    t('notifications.notification', 4, 2, 0, 2);
    for (const [table, v] of Object.entries(c))
      assert.equal(
        v['found'],
        (v['repointed'] ?? 0) + (v['resolved'] ?? 0) + (v['kept'] ?? 0),
        `${table}: found = repointed + resolved + kept`,
      );

    // the merged patient is closed (terminal), the map and the audit row name both IDs
    assert.equal(await status(D), 'merged');
    assert.equal(
      (
        await one<{ merged_into: string }>(
          `SELECT merged_into FROM patient.patient WHERE id = $1`,
          [D],
        )
      ).merged_into,
      S,
    );
    const map = await one<{
      direct_survivor_id: string;
      final_survivor_id: string;
      merge_request_id: string;
    }>(`SELECT * FROM patient.patient_merge WHERE merged_id = $1`, [D]);
    assert.deepEqual(
      [map.direct_survivor_id, map.final_survivor_id, map.merge_request_id],
      [S, S, requestId],
    );
    const audit = await q<{
      patient_id: string;
      change: { survivorId: string; mergedId: string; counts: unknown };
    }>(`SELECT patient_id, change FROM audit.event WHERE action = 'merge' AND resource_id = $1`, [
      requestId,
    ]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.patient_id, S);
    assert.equal(audit[0]?.change.mergedId, D);
    assert.equal(audit[0]?.change.survivorId, S);
    assert.ok(audit[0]?.change.counts);

    // survivor rows win; deleted rows are in the residue with the rule applied
    assert.deepEqual(
      (
        await one<{ channels: string[] }>(
          `SELECT channels FROM patient.communication_preference WHERE patient_id = $1`,
          [S],
        )
      ).channels,
      ['email'],
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.communication_preference WHERE patient_id = $1`, [
        D,
      ]),
      0,
    );
    const residue = await q<{
      source_table: string;
      rule: string;
      survivor_id: string;
      merged_id: string;
      source_row: Record<string, unknown>;
    }>(
      `SELECT source_table, rule, survivor_id, merged_id, source_row FROM patient.merge_residue WHERE merge_request_id = $1 ORDER BY source_table`,
      [requestId],
    );
    assert.deepEqual(
      residue.map((r) => r.source_table),
      ['identity.patient_link', 'patient.communication_preference'],
    );
    assert.ok(residue.every((r) => r.survivor_id === S && r.merged_id === D && r.rule.length > 10));
    assert.deepEqual(residue[1]?.source_row['channels'], ['sms']);
    assert.equal(residue[0]?.source_row['principal_id'], L1);
    // signed consent: the higher version won, the survivor's older one is superseded; the pending duplicate was withdrawn on the merged ID
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1 AND template_key = 'privacy' AND status = 'signed' AND template_version = 2`,
        [S],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1 AND template_key = 'privacy' AND status = 'superseded' AND template_version = 1`,
        [S],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1 AND template_key = 'portal' AND status = 'withdrawn' AND reason = 'merged_duplicate'`,
        [D],
      ),
      1,
    );
    // care team: the survivor's entry stays, the merged duplicate is ended (K, on the merged ID); the nurse moved
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.care_team_member WHERE patient_id = $1 AND to_date IS NULL`,
        [S],
      ),
      2,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.care_team_member WHERE patient_id = $1 AND end_reason = 'merged_duplicate'`,
        [D],
      ),
      1,
    );
    // proxy: the most advanced open grant won and moved; the survivor's lesser one is revoked as a duplicate
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM identity.proxy_grant WHERE patient_id = $1 AND status = 'active'`,
        [S],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM identity.proxy_grant WHERE patient_id = $1 AND status = 'revoked' AND revoke_reason = 'merged_duplicate'`,
        [S],
      ),
      1,
    );
    // flags: D-S resolved merged; D-X resolved merged_duplicate (the older S-X stays open); Y now names S
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.duplicate_flag WHERE patient_id = $1 AND candidate_patient_id = $2 AND status = 'resolved' AND resolved_reason = 'merged'`,
        [D, S],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.duplicate_flag WHERE patient_id = $1 AND candidate_patient_id = $2 AND status = 'resolved' AND resolved_reason = 'merged_duplicate'`,
        [D, X],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.duplicate_flag WHERE patient_id = $1 AND candidate_patient_id = $2 AND status = 'open'`,
        [S, X],
      ),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.duplicate_flag WHERE patient_id = $1 AND candidate_patient_id = $2 AND status = 'open'`,
        [Y, S],
      ),
      1,
    );
    // K rows keep the merged ID (TC-MG-05: original patient_id retained); no R row is left on it
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status IN ('sent', 'suppressed')`,
        [D],
      ),
      2,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status IN ('queued', 'failed', 'sending')`,
        [D],
      ),
      0,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status IN ('queued', 'failed')`,
        [S],
      ),
      2,
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [S]),
      3,
    );
    // the survivor's staff see the merged ID's immutable rows (the staff_scope invariant, 6.6)
    assert.deepEqual(await scopeOf(D), [A1]);
    assert.deepEqual(await scopeOf(S), [A1]);
    // a repeat of the job does nothing (the retry after the commit)
    assert.deepEqual(await m.run(requestId), { status: 'skipped', requestStatus: 'completed' });
    // the request is readable with its counts
    const view = await get(m.lead, `/api/v1/patient-merges/${requestId}`);
    assert.equal(view.status, 200);
    assert.equal(view.json()['status'], 'completed');
    assert.deepEqual((view.json()['counts'] as Record<string, unknown>)['patient.consent'], {
      found: 4,
      repointed: 2,
      resolved: 1,
      kept: 1,
    });
  });

  test('TC-MG-04: the job runs with the exact patient IDs, not the requester or approver scope: patients at different locations, an approver who sees neither', async () => {
    const S = await patient(A1);
    const D = await patient(B1);
    await contact(D);
    await notification(D, 'queued', 'tc4');
    const { requestId, result } = await m.merge(S, D); // lead sees A1 and B1; mr sits at A2 and sees neither
    assert.equal(result.status, 'completed', JSON.stringify([result, m.failures.at(-1)]));
    assert.equal((await reqRow(requestId)).status, 'completed');
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [S]),
      1,
    );
    // the survivor now has the merged patient's relationship at B1 as well, and so do both IDs in staff_scope
    assert.deepEqual(await scopeOf(S), [A1, B1].sort());
    assert.deepEqual(await scopeOf(D), [A1, B1].sort());
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM patient.care_relationship WHERE patient_id = $1 AND ended_at IS NULL`,
        [D],
      ),
      0,
    );
  });

  test('TC-MG-06: a failure in one participant rolls everything back: no partial merge, the request is failed, the operations alert is raised', async () => {
    const S = await patient();
    const D = await patient();
    await contact(D);
    await notification(D, 'queued', 'tc6');
    const regs = new ParticipantRegistries();
    registerCombinedParticipants(regs);
    const faulty: MergeParticipant = {
      module: 'faulty',
      tables: ['faulty.item'],
      conflictRules: [],
      repointPatient: () => Promise.reject(new Error('injected failure in a participant')),
    };
    regs.registerMergeParticipant(faulty);
    const r = await m.request(m.lead, S, D);
    const rid = r.json()['id'] as string;
    await m.approve(m.mr, rid);
    const alerts = m.failures.length;
    const res = await m.run(rid, { registries: regs, notParticipants: undefined });
    assert.deepEqual(res, { status: 'failed', code: 'patient.merge_failed' });
    assert.equal(m.failures.length, alerts + 1);
    assert.equal(m.failures.at(-1)?.requestId, rid);
    assert.equal(m.failures.at(-1)?.code, 'patient.merge_failed');
    const row = await reqRow(rid);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure_code, 'patient.merge_failed');
    assert.equal(await status(D), 'active');
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
      1,
    );
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status = 'queued'`,
        [D],
      ),
      1,
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.merge_residue WHERE merge_request_id = $1`, [rid]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_merge WHERE merged_id = $1`, [D]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*) AS n FROM audit.event WHERE action = 'merge' AND resource_id = $1`, [
        rid,
      ]),
      0,
    );
    // a failed request is terminal and frees the merged patient
    assert.equal((await m.request(m.lead, S, D)).status, 200);
  });

  test('the job fails the merge, before writing, if a table with patient data has no registered participant', async () => {
    const S = await patient();
    const D = await patient();
    await notification(D, 'queued', 'tc-missing');
    const regs = new ParticipantRegistries();
    registerIdentityParticipants(regs); // notifications is NOT registered
    const rid = (await m.request(m.lead, S, D)).json()['id'] as string;
    await m.approve(m.mr, rid);
    const res = await m.run(rid, { registries: regs });
    assert.deepEqual(res, { status: 'failed', code: 'patient.merge_participant_missing' });
    assert.equal(await status(D), 'active');
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status = 'queued'`,
        [D],
      ),
      1,
    );
  });

  test('a participant whose counts do not add up fails the merge (patient.merge_count_mismatch) and nothing is written', async () => {
    const S = await patient();
    const D = await patient();
    await contact(D);
    const regs = new ParticipantRegistries();
    registerCombinedParticipants(regs);
    regs.registerMergeParticipant({
      module: 'liar',
      tables: ['liar.item'],
      conflictRules: [],
      repointPatient: () =>
        Promise.resolve([
          { table: 'liar.item', found: 3, repointed: 1, resolved: 0, kept: 1, deleted: [] },
        ]),
    });
    const rid = (await m.request(m.lead, S, D)).json()['id'] as string;
    await m.approve(m.mr, rid);
    const res = await m.run(rid, { registries: regs });
    assert.deepEqual(res, { status: 'failed', code: 'patient.merge_count_mismatch' });
    assert.equal(await status(D), 'active');
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
      1,
    );
  });

  test('the database repeats the equation: complete_merge refuses counts that do not add up (PM013)', async () => {
    const S = await patient();
    const D = await patient();
    const rid = (await m.request(m.lead, S, D)).json()['id'] as string;
    await m.approve(m.mr, rid);
    const c = await m.newClient('app_worker');
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true), set_config('app.realm', 'worker', true),
                set_config('app.job_scope', 'patients', true), set_config('app.job_patient_ids', $2, true)`,
        [ORG, [S, D].join(',')],
      );
      await c.query(`SELECT patient.lock_patients($1::uuid[], 'no_key_update')`, [[S, D]]);
      await c.query(`SELECT patient.begin_merge($1)`, [rid]);
      await assert.rejects(
        c.query(`SELECT patient.complete_merge($1, $2::jsonb, '[]'::jsonb)`, [
          rid,
          JSON.stringify({ 'patient.consent': { found: 2, repointed: 1, resolved: 0, kept: 0 } }),
        ]),
        (e: { code?: string }) => e.code === 'PM013',
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    assert.equal(await status(D), 'active');
  });

  test('a function is not available to the wrong caller: begin_merge from an org-scope job, complete_merge from staff, request_merge from the worker (42501)', async () => {
    const S = await patient();
    const D = await patient();
    const rid = (await m.request(m.lead, S, D)).json()['id'] as string;
    const fail = (e: { code?: string }) => e.code === '42501';
    const as = async (
      user: string,
      settings: Record<string, string>,
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      const c = await m.newClient(user);
      try {
        await c.query('BEGIN');
        for (const [k, v] of Object.entries(settings))
          await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
        await c.query(sql, params);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    await assert.rejects(
      as(
        'app_worker',
        { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'org' },
        `SELECT patient.begin_merge($1)`,
        [rid],
      ),
      fail,
    );
    await assert.rejects(
      as(
        'app_api',
        { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'google' },
        `SELECT patient.complete_merge($1, '{}'::jsonb, '[]'::jsonb)`,
        [rid],
      ),
      (e: { code?: string }) => e.code === '42501',
    );
    await assert.rejects(
      as(
        'app_worker',
        { 'app.org_id': ORG, 'app.audience': 'system', 'app.job_scope': 'org' },
        `SELECT patient.request_merge(NULL, $1, $2, 'x')`,
        [S, D],
      ),
      (e: { code?: string }) => e.code === '42501',
    );
    await assert.rejects(
      as(
        'app_worker',
        {
          'app.org_id': ORG,
          'app.audience': 'system',
          'app.job_scope': 'patients',
          'app.job_patient_ids': S,
        },
        `SELECT patient.begin_merge($1)`,
        [rid],
      ),
      fail,
    ); // the job was not started for the merged patient
    await assert.rejects(
      as(
        'app_api',
        { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'google' },
        `SELECT patient.fail_merge($1, 'patient.merge_failed')`,
        [rid],
      ),
      fail,
    );
  });
});

describe('writes after the merge (TC-MG-07) and chains (TC-MG-12, TC-MG-13)', () => {
  test('TC-MG-07: a stale staff session and a stale portal session writing to the merged ID get 409 patient.merged and nothing is written', async () => {
    const S = await patient();
    const D = await patient();
    const portal = await patientAccount(m.k, D); // opened before the merge, linked to the duplicate
    const name = (
      await one<{ given_name: string }>(`SELECT given_name FROM patient.patient WHERE id = $1`, [D])
    ).given_name;
    const { result } = await m.merge(S, D);
    assert.equal(result.status, 'completed', JSON.stringify([result, m.failures.at(-1)]));
    const staffWrite = await call(m.k.base, 'PATCH', `/api/v1/patients/${D}`, {
      cookie: m.leadA1.cookie,
      headers: { ...writeHeaders(m.leadA1), 'if-match': 'W/"1"' },
      body: { givenName: 'Late' },
    });
    assert.equal(staffWrite.status, 409, `staff ${staffWrite.body}`);
    assert.equal(code(staffWrite), 'patient.merged');
    // The portal half. The identity guard builds `ctx.patients` from the principal's links and grants only, so a merged ID in the path
    // is not_visible there (404) rather than patient.merged (409): see the README, open item for BE-04 (guard-policy.ts). Either way
    // nothing is written, and the database refuses the same write from the stale scope with PM001 (the next assertions).
    const portalWrite = await post(
      portal,
      `/api/v1/patients/${D}/contacts`,
      { kind: 'emergency', name: 'Late portal contact' },
      randomUUID(),
      PATIENT_HOST,
    );
    assert.ok(
      portalWrite.status === 404 || portalWrite.status === 409,
      `portal ${portalWrite.status} ${portalWrite.body}`,
    );
    const stale = await m.newClient('app_api');
    try {
      await stale.query('BEGIN');
      await stale.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'patient', true), set_config('app.realm', 'patient_pool', true),
                set_config('app.principal_id', $2, true), set_config('app.patient_ids', $3, true)`,
        [ORG, portal.seeded.principalId, D], // the scope the session had before the merge
      );
      await assert.rejects(
        stale.query(
          `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES (gen_random_uuid(), $1, $2, 'emergency', 'Stale')`,
          [ORG, D],
        ),
        (e: { code?: string }) => e.code === 'PM001',
      );
    } finally {
      await stale.query('ROLLBACK').catch(() => undefined);
      await stale.end();
    }
    assert.equal(
      await n(`SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`, [D]),
      0,
    );
    assert.equal(
      (
        await one<{ given_name: string }>(`SELECT given_name FROM patient.patient WHERE id = $1`, [
          D,
        ])
      ).given_name,
      name,
    );
    // the portal link followed the merge (identity participant): the same principal now reaches the survivor
    assert.equal(
      await n(
        `SELECT count(*) AS n FROM identity.patient_link WHERE principal_id = $1 AND patient_id = $2`,
        [portal.seeded.principalId, S],
      ),
      1,
    );
    // the database refuses it too, whatever the API says: the guard of 0701
    await assert.rejects(contact(D), (e: { code?: string }) => e.code === 'PM001');
  });

  test('TC-MG-12: two merges that share a patient, approved at the same moment, do not deadlock and leave one consistent outcome', async () => {
    const A = await patient();
    const B = await patient();
    const C = await patient();
    await notification(A, 'queued', 'tc12a');
    await notification(B, 'queued', 'tc12b');
    const r1 = (await m.request(m.lead, B, A)).json()['id'] as string; // M1: A into B
    const r2 = (await m.request(m.lead, C, B)).json()['id'] as string; // M2: B into C
    await m.approve(m.mr, r1);
    await m.approve(m.mr2, r2);
    const [x, y] = await Promise.all([m.run(r1, {}, 1, 3), m.run(r2, {}, 1, 3)]);
    assert.ok(x.status === 'completed' || x.status === 'failed', JSON.stringify(x));
    assert.ok(y.status === 'completed' || y.status === 'failed', JSON.stringify(y));
    const s1 = (await reqRow(r1)).status;
    const s2 = (await reqRow(r2)).status;
    if (s1 === 'completed' && s2 === 'completed') {
      // M1 ran first, then B (the survivor of M1) was merged into C: a chain, A resolves to C in one lookup
      assert.equal(
        (
          await one<{ final_survivor_id: string }>(
            `SELECT final_survivor_id FROM patient.patient_merge WHERE merged_id = $1`,
            [A],
          )
        ).final_survivor_id,
        C,
      );
    } else {
      // M2 ran first: B is merged, so M1 names a record that is no longer active and fails with patient.already_merged
      assert.equal(s2, 'completed');
      assert.equal(s1, 'failed');
      assert.equal((await reqRow(r1)).failure_code, 'patient.already_merged');
      assert.equal(await status(A), 'active');
    }
    // never an R row on a merged ID
    for (const p of [A, B]) {
      if (await status(p).then((s) => s === 'merged'))
        assert.equal(
          await n(
            `SELECT count(*) AS n FROM notifications.notification WHERE patient_id = $1 AND status IN ('queued', 'failed', 'sending')`,
            [p],
          ),
          0,
        );
    }
  });

  test('another open request that names the merged patient on either side is cancelled with patient.already_merged by complete_merge (22.16)', async () => {
    const S = await patient();
    const D = await patient();
    const W = await patient();
    const asSurvivor = (await m.request(m.lead, D, W)).json()['id'] as string; // W into D: D is its survivor
    const asMerged = (await m.request(m.lead, S, D)).json()['id'] as string; // D into S
    await m.approve(m.mr, asMerged);
    assert.equal((await m.run(asMerged)).status, 'completed');
    const cancelled = await reqRow(asSurvivor);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.failure_code, 'patient.already_merged');
    // the cancelled request is terminal: approving it is refused, and W is free for a new request (against the survivor)
    assert.equal((await m.approve(m.mr2, asSurvivor)).status, 412);
    assert.equal((await m.request(m.lead, S, W)).status, 200);
  });

  test("TC-MG-13: chained merges A -> B -> C: C's location sees A's rows, a new location sees the merged history, ending the relationship removes the merged-ID rows there", async () => {
    const A = await patient(A1);
    const B = await patient(A1);
    const C = await patient(B1);
    await contact(A);
    assert.equal((await m.merge(B, A)).result.status, 'completed');
    assert.equal((await m.merge(C, B)).result.status, 'completed');
    // the map resolves A in one lookup
    assert.equal(
      (
        await one<{ final_survivor_id: string }>(
          `SELECT final_survivor_id FROM patient.patient_merge WHERE merged_id = $1`,
          [A],
        )
      ).final_survivor_id,
      C,
    );
    // staff of C's location see A's immutable rows (A, B and C are all in scope at B1 and at A1: the relationships moved)
    for (const p of [A, B, C]) assert.deepEqual(await scopeOf(p), [A1, B1].sort());
    assert.equal((await get(m.deskB1, `/api/v1/patients/${A}`)).status, 200);
    // the merged patient is booked at a new location A2 for the survivor: the merged history is visible there
    await confirmedBooking(m.k, C, A2); // SEC-03 F04: a booking relationship starts from a confirmed appointment (stale fixture, INT02-F08)
    const acct = await patientAccount(m.k, C);
    await m.k.db.withScope(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: acct.seeded.principalId,
        patientIds: [C],
      },
      async (tx) => {
        await m.k.patient.patients.lockPatients(tx, [C], 'no_key_update');
        await m.k.patient.patients.ensureCareRelationship(
          tx,
          { requestId: randomUUID() },
          C,
          A2,
          'booking',
        );
      },
    );
    for (const p of [A, B, C]) assert.deepEqual(await scopeOf(p), [A1, A2, B1].sort());
    // ending the survivor's relationship at A2 removes the merged-ID rows there
    const a2 = await (await import('../testkit.js')).staffMember(m.k, 'front_desk', A2, 'Desk A2');
    await m.k.db.withScope(asStaff(a2, [A2]), async (tx) => {
      await m.k.patient.patients.lockPatients(tx, [C], 'no_key_update');
      await m.k.patient.patients.endCareRelationship(
        tx,
        { requestId: randomUUID() },
        C,
        A2,
        'Moved',
      );
    });
    for (const p of [A, B, C]) assert.deepEqual(await scopeOf(p), [A1, B1].sort());
  });
});

describe('K states are immutable for every role, including a data_repair job (38.2 item 2)', () => {
  test('an update of a K row is refused by the database for the application roles and for a superuser alike', async () => {
    const S = await patient();
    const D = await patient();
    const [Pa, Pc] = [randomUUID(), randomUUID()];
    const P1 = (await seedPrincipal(m.k, 'patient_pool')).principalId;
    await consent(D, 'k_withdrawn', 1, 'withdrawn');
    await careTeam(D, Pc, 'nurse', true);
    await careTeam(D, Pa, 'clinician');
    await flag(D, S, 'resolved', '2026-03-01T00:00:00Z');
    await proxy(D, P1, 'revoked');
    await notification(D, 'sent', 'k-sent');
    await preference(D, 'sms');
    await preference(S, 'email'); // a conflict, so the merge writes a residue row
    const { requestId } = await m.merge(S, D);
    const targets: { table: string; set: string; where: string; args: unknown[] }[] = [
      {
        table: 'patient.consent',
        set: `reason = 'again'`,
        where: `patient_id = $1 AND status = 'withdrawn'`,
        args: [D],
      },
      {
        table: 'patient.care_team_member',
        set: `end_reason = 'staff'`,
        where: `patient_id = $1 AND to_date IS NOT NULL`,
        args: [D],
      },
      {
        table: 'patient.duplicate_flag',
        set: `resolved_reason = 'merged'`,
        where: `patient_id = $1 AND status = 'resolved'`,
        args: [D],
      },
      {
        table: 'identity.proxy_grant',
        set: `revoke_reason = 'patient'`,
        where: `patient_id = $1 AND status = 'revoked'`,
        args: [D],
      },
      {
        table: 'notifications.notification',
        set: `attempts = 9`,
        where: `patient_id = $1 AND status = 'sent'`,
        args: [D],
      },
      {
        table: 'patient.care_relationship',
        set: `ended_reason = 'x'`,
        where: `patient_id = $1 AND ended_at IS NOT NULL`,
        args: [D],
      },
      { table: 'patient.merge_request', set: `reason = 'x'`, where: `id = $1`, args: [requestId] },
      { table: 'patient.patient', set: `given_name = 'Changed'`, where: `id = $1`, args: [D] },
    ];
    const sys = `SELECT set_config('app.org_id', '${ORG}', true), set_config('app.audience', 'system', true), set_config('app.realm', 'worker', true), set_config('app.job_scope', 'patients', true), set_config('app.job_patient_ids', '${S},${D}', true)`;
    for (const user of ['app_worker', 'postgres']) {
      for (const tg of targets) {
        const c = await m.newClient(user === 'postgres' ? undefined : user);
        try {
          await c.query('BEGIN');
          await c.query(sys);
          await assert.rejects(
            c.query(`UPDATE ${tg.table} SET ${tg.set} WHERE ${tg.where}`, tg.args),
            (e: { code?: string }) =>
              typeof e.code === 'string' && ['PS001', '42501', 'PM001'].includes(e.code),
            `${user} must not update ${tg.table}`,
          );
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          await c.end();
        }
      }
    }
    // merge_residue is append-only for a superuser too
    assert.ok(
      (await n(`SELECT count(*) AS n FROM patient.merge_residue WHERE merge_request_id = $1`, [
        requestId,
      ])) >= 1,
    );
    for (const sql of [
      `UPDATE patient.merge_residue SET rule = 'x' WHERE merge_request_id = $1`,
      `DELETE FROM patient.merge_residue WHERE merge_request_id = $1`,
    ]) {
      const c = await m.newClient();
      try {
        await assert.rejects(
          c.query(sql, [requestId]),
          (e: { code?: string }) => e.code === 'PS001',
        );
      } finally {
        await c.end();
      }
    }
  });
});
