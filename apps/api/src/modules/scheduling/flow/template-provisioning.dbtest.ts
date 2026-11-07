// INT02-R10-B1: on a freshly migrated database nothing published the R1 templates, so the waitlist offer job threw
// `kernel.validation_failed` (template missing) and retried for ever. `provisionR1Templates` is the boot step; this proves
// a database with an EMPTY notifications.template yields a waitlist_offer offer, and a queued waitlist_offer notification,
// through the real worker handlers once it has run, and that the step is idempotent.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/template-provisioning.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { R1_TEMPLATE_KEYS, provisionR1Templates } from '../../notifications/index.js';
import { uuidv7 } from '../core/ids.js';
import { A1, ORG, SVC, setupFlow, slotStart, workerJobs } from './testkit.js';
import type { FlowKit, WorkerJobs } from './testkit.js';

let t: FlowKit;
let W: WorkerJobs;
before(async () => {
  t = await setupFlow('tplprov', { noTemplates: true });
  W = await workerJobs();
  await t.allowWaitlist(SVC);
});
after(async () => {
  await t?.close();
});

const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const iso = (d: Date): string => d.toISOString();

describe('R1 template provisioning (INT02-R10-B1)', () => {
  test('a fresh database has no template', async () => {
    assert.equal((await q(`SELECT 1 FROM notifications.template`)).length, 0);
  });

  test('concurrent boots on an empty database provision each key once (advisory lock)', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => provisionR1Templates(t.api, ORG, ['en'])));
    assert.equal(
      rs.reduce((n, r) => n + r.provisioned.length, 0),
      R1_TEMPLATE_KEYS.length,
    );
    const dup = await q(
      `SELECT key FROM notifications.template WHERE status = 'published' GROUP BY key, channel, language HAVING count(*) > 1`,
    );
    assert.equal(dup.length, 0);
  });

  test('every R1 key is published, and a second run changes nothing', async () => {
    const published = await q<{ key: string; n: string }>(
      `SELECT key, count(*) AS n FROM notifications.template WHERE status = 'published' GROUP BY key`,
    );
    assert.deepEqual(published.map((r) => r.key).sort(), [...R1_TEMPLATE_KEYS].sort());
    const before = Number(
      (await q<{ n: string }>(`SELECT count(*) AS n FROM notifications.template`))[0]?.n,
    );
    const second = await provisionR1Templates(t.api, ORG, ['en']);
    assert.deepEqual(second.provisioned, []);
    assert.deepEqual(second.present.sort(), [...R1_TEMPLATE_KEYS].sort());
    assert.equal(
      Number((await q<{ n: string }>(`SELECT count(*) AS n FROM notifications.template`))[0]?.n),
      before,
    );
  });

  test('with the provisioned templates the real worker path creates a waitlist_offer offer and notification', async () => {
    await provisionR1Templates(t.api, ORG, ['en']);
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
    const booker = await t.bare(8101);
    const rid = await t.confirmed(booker, doc, slotStart(60));
    const waiter = await t.bare(8201);
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
    t.realAvailability.on = true;
    try {
      await W.runOnSlotFreed(t.jobs, { occupancyId: rid });
      const r = await W.runOfferWaitlist(t.jobs, { occupancyId: rid });
      assert.equal(r.outcome, 'offered', JSON.stringify(r));
    } finally {
      t.realAvailability.on = false;
    }
    const offers = await q<{ status: string }>(
      `SELECT status FROM scheduling.waitlist_offer WHERE waitlist_entry_id = $1`,
      [entry.id],
    );
    assert.deepEqual(
      offers.map((o) => o.status),
      ['offered'],
    );
    const sent = await q<{ n: string }>(
      `SELECT count(*) AS n FROM notifications.notification WHERE template_key = 'waitlist_offer' AND patient_id = $1`,
      [waiter.patientId],
    );
    assert.ok(Number(sent[0]?.n) >= 1, 'a waitlist_offer notification was queued');
  });
});
