// INT02-R9-B1: `scheduling.offer_waitlist` as the real worker runs it. The job's per-candidate transaction is a patients-scope system
// job on the `app_worker` role; the availability check of the hold reads identity.principal (is the clinician active?), which the
// organisation-scope policy of 0502 did not show there, so every slot resolved `outside_hours`, every candidate was skipped and the job
// ended in plain success without an offer. The other waitlist tests stub `availability.resolve`; this one switches the booking core to
// the real search (template, rule, service/location offer, principal) and runs the real job handler on the real role and scope.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/waitlist-worker-scope.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { uuidv7 } from '../core/ids.js';
import { A1, ORG, SVC, setupFlow, slotStart, workerJobs } from './testkit.js';
import type { FlowKit, WorkerJobs } from './testkit.js';

let t: FlowKit;
let W: WorkerJobs;
before(async () => {
  t = await setupFlow('wlws');
  W = await workerJobs();
  await t.allowWaitlist(SVC);
});
after(async () => {
  await t?.close();
});

const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const iso = (d: Date): string => d.toISOString();

/** A doctor with a real all-day template at A1 for this service, so the real availability search can answer. */
async function openDoctor(): Promise<string> {
  const doc = (await t.doctor()).principalId;
  await t.k.sa.query(
    `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1, $2, $3)`,
    [ORG, SVC, doc],
  );
  await t.k.sa.query(
    `INSERT INTO organisation.service_location (organisation_id, service_id, location_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [ORG, SVC, A1],
  );
  const tid = uuidv7();
  await t.k.sa.query(
    `INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1, $2, $3, $4, current_date - 2)`,
    [tid, ORG, doc, A1],
  );
  for (let wd = 0; wd < 7; wd++)
    await t.k.sa.query(
      `INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, mode) VALUES ($1, $2, $3, $4, $5, '00:00', '23:30', 'either')`,
      [uuidv7(), ORG, tid, doc, wd],
    );
  return doc;
}

let day = 40;
async function scenario() {
  const doc = await openDoctor();
  const booker = await t.bare(7100 + (day += 1));
  const start = slotStart((day += 2));
  const rid = await t.confirmed(booker, doc, start);
  const waiter = await t.bare(7200 + day);
  const entry = await t.as(waiter.scope, (tx) =>
    t.flow.waitlist.createEntry(
      tx,
      { requestId: randomUUID() },
      {
        patientId: waiter.patientId,
        serviceId: SVC,
        clinicianId: doc,
        from: iso(new Date(Date.now() + 3_600_000)),
        to: iso(new Date(Date.now() + 90 * 86_400_000)),
      },
    ),
  );
  await t.as(booker.scope, (tx) =>
    t.core.cancel(tx, { requestId: randomUUID() }, rid, { reason: 'cannot come' }),
  );
  return { rid, waiter, entry };
}

describe('offer_waitlist as app_worker in patients scope (INT02-R9-B1)', () => {
  test('the real worker role and scope produce an offer, resolved against the real availability rules', async () => {
    const s = await scenario();
    t.realAvailability.on = true;
    try {
      await W.runOnSlotFreed(t.jobs, { occupancyId: s.rid });
      const r = await W.runOfferWaitlist(t.jobs, { occupancyId: s.rid });
      assert.equal(r.outcome, 'offered', JSON.stringify(r));
    } finally {
      t.realAvailability.on = false;
    }
    const offers = await q<{ status: string; patient_id: string }>(
      `SELECT status, patient_id FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [s.entry.id],
    );
    assert.deepEqual(
      offers.map((o) => [o.status, o.patient_id]),
      [['offered', s.waiter.patientId]],
    );
  });

  test('the patients-scope policy shows app_worker only active clinician principals: no patient-pool rows, nothing outside patients/org scope', async () => {
    const s = await scenario();
    const seen = await t.asWorker(
      {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [s.waiter.patientId],
      },
      async (tx) =>
        (await tx.query(`SELECT DISTINCT realm FROM identity.principal ORDER BY realm`)).rows.map(
          (r) => String((r as Record<string, unknown>)['realm']),
        ),
    );
    assert.deepEqual(seen, ['google']);
  });

  test('a job that skips every candidate does not end silently: the outcome carries the reasons and a warning is logged', async () => {
    // no template for this doctor: the real search answers outside_hours for every candidate
    const doc = (await t.doctor()).principalId;
    const booker = await t.bare(7300 + (day += 1));
    const start = slotStart((day += 2));
    const rid = await t.confirmed(booker, doc, start);
    const waiter = await t.bare(7400 + day);
    await t.as(waiter.scope, (tx) =>
      t.flow.waitlist.createEntry(
        tx,
        { requestId: randomUUID() },
        {
          patientId: waiter.patientId,
          serviceId: SVC,
          clinicianId: doc,
          from: iso(new Date(Date.now() + 3_600_000)),
          to: iso(new Date(Date.now() + 90 * 86_400_000)),
        },
      ),
    );
    await t.as(booker.scope, (tx) =>
      t.core.cancel(tx, { requestId: randomUUID() }, rid, { reason: 'cannot come' }),
    );
    const warnings: { msg: string; f: unknown }[] = [];
    const deps = {
      ...t.jobs,
      log: {
        ...t.jobs.log,
        warn: (msg: string, f?: unknown) => void warnings.push({ msg, f }),
      },
    } as unknown as FlowKit['jobs'];
    t.realAvailability.on = true;
    try {
      await W.runOnSlotFreed(deps, { occupancyId: rid });
      const r = (await W.runOfferWaitlist(deps, { occupancyId: rid })) as {
        outcome: string;
        tried?: number;
        skipped?: Record<string, number>;
      };
      assert.equal(r.outcome, 'no_candidate');
      assert.equal(r.tried, 1);
      assert.equal(
        Object.values(r.skipped ?? {}).reduce((a, b) => a + b, 0),
        1,
      );
      assert.equal(warnings.filter((w) => /every candidate was skipped/.test(w.msg)).length, 1);
    } finally {
      t.realAvailability.on = false;
    }
  });
});
