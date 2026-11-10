// TC-CAL-02..05 mechanics (TEST-CASES 7.3) on ENV-INT/ci. The Google tenant is NOT available on ci: TC-CAL-01 (a real Busy block in Google),
// TC-CAL-03/TC-BK-03 against a real meeting, TC-CAL-05 steps 3-5 (valid token + sync token) and TC-CAL-06 stay Blocked/pending on
// ENV-INT/staging with the Google Workspace test tenant. What runs here is what the product decides without Google: busy rows from the
// calendar-sync table make time unavailable, stale data is flagged and never silently dropped, the push webhook refuses a bad token, and
// the data model carries nothing from which a patient name or a condition could reach a calendar block.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  SVC,
  ORG,
  newPatient,
  search,
  nextDay,
  sql,
  closeAdmin,
  newService,
  setPolicy,
  newDoctor,
  state,
  uuid,
} from '../../e2e/journeys/lib/world.mjs';

after(closeAdmin);

function postWebhook(headers) {
  const port = state().ports.api;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/webhooks/google/calendar',
        method: 'POST',
        headers: {
          host: 'integrations.localhost',
          'x-forwarded-for': '10.202.0.7',
          'x-client-release': 'r1.000000000000',
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, text: b }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
const busy = (clinicianId, from, to) =>
  sql(
    `INSERT INTO scheduling.busy_block (organisation_id, clinician_principal_id, period, source, external_hash, synced_at) VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz,'[)'),'google',$5,now())`,
    [ORG, clinicianId, from, to, randomBytes(32)],
  );

describe('TC-CAL calendar sync mechanics (no Google tenant on ci)', () => {
  it('TC-CAL-01/02 structure: a calendar block and its event map hold no patient, reason, diagnosis or service name', async () => {
    const cols = await sql(
      `SELECT table_name, column_name FROM information_schema.columns WHERE (table_schema = 'calendar_sync' AND table_name IN ('event_map','calendar_link','watch_channel')) OR (table_schema = 'scheduling' AND table_name = 'busy_block')`,
    );
    const bad = cols.rows.filter((c) =>
      /patient|(?<!token_secret_)name|title|summary|reason|diagnos|service|description/i.test(
        c.column_name,
      ),
    );
    assert.deepEqual(
      bad,
      [],
      `no column that could carry PHI or a condition-revealing label: ${JSON.stringify(bad)}`,
    );
    const ics = await sql(
      `SELECT body FROM notifications.template WHERE channel = 'ics' AND status = 'published'`,
    );
    assert.ok(ics.rows.length > 0, 'a published .ics template exists');
    for (const r of ics.rows) {
      const summary = /^SUMMARY:(.*)$/m.exec(r.body)?.[1] ?? '';
      assert.match(
        summary,
        /^Appointment$|^\{\{/i,
        `the event title is a neutral label, got "${summary}"`,
      );
      assert.ok(
        !/HIV|clinic for|Synthetic|Dr\.?\s/i.test(r.body),
        'no condition-revealing or clinician text in the .ics template',
      );
      for (const v of r.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g))
        assert.ok(
          ['start_at', 'end_at', 'location_name', 'event_uid', 'time_zone', 'portal_link'].includes(
            v[1],
          ),
          `.ics variable ${v[1]} is on the allowlist`,
        );
    }
  });

  it('TC-CAL-03 synced busy time makes that time unavailable within one search (no cache)', async () => {
    const svc = await newService();
    await setPolicy(svc, { cutoff: 0 });
    const doc = await newDoctor({ services: [svc] });
    const p = await newPatient();
    const day = nextDay();
    const before = await search(p.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.ok(before.slots.length >= 3);
    const target = before.slots[1];
    await busy(doc.id, target.startsAt, target.endsAt);
    const after = await search(p.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.ok(
      !after.slots.some((s) => s.startsAt === target.startsAt),
      'the busy slot is not offered',
    );
    assert.equal(
      after.slots.length,
      before.slots.length - 1,
      'only the overlapping slot is removed',
    );
  });

  it('TC-CAL-04 stale sync: busy rows are still used and the answer is flagged; fresh data is not flagged; threshold from the setting', async () => {
    const mins = Number(
      (
        await sql(
          `SELECT value FROM kernel.setting WHERE key = 'calendar_stale_minutes' AND location_id IS NULL`,
        )
      ).rows[0]?.value,
    );
    assert.ok(mins > 0, `calendar_stale_minutes is a configured G2 setting, got ${mins}`);
    const svc = await newService();
    await setPolicy(svc, { cutoff: 0 });
    const doc = await newDoctor({ services: [svc] });
    const p = await newPatient();
    const day = nextDay();
    const probe = await search(p.client, { serviceId: svc, clinicianId: doc.id, day });
    const t = probe.slots[0];
    await busy(doc.id, t.startsAt, t.endsAt);
    const syncedAgo = (m) =>
      sql(
        `UPDATE scheduling.busy_block SET synced_at = now() - ($2 || ' minutes')::interval WHERE clinician_principal_id = $1::uuid`,
        [doc.id, String(m)],
      );
    await syncedAgo(Math.max(1, mins - 5));
    const fresh = await search(p.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(fresh.json.availabilityStale, false, 'before the threshold: not flagged');
    assert.ok(
      !fresh.slots.some((s) => s.startsAt === t.startsAt),
      'the last-known busy time is used',
    );
    await syncedAgo(mins + 5);
    const stale = await search(p.client, { serviceId: svc, clinicianId: doc.id, day });
    assert.equal(stale.json.availabilityStale, true, 'after the threshold: flagged, not silent');
    assert.ok(
      !stale.slots.some((s) => s.startsAt === t.startsAt),
      'stale data is not silently dropped either',
    );
  });

  it('TC-CAL-05 steps 1-2 the push webhook refuses a wrong HMAC token and an unknown channel; nothing is stored or enqueued', async () => {
    const before = await sql(`SELECT count(*)::int c FROM integration_core.inbound_message`).catch(
      () => ({ rows: [{ c: null }] }),
    );
    const hdr = (token, channel = 'ch-' + uuid().slice(0, 8)) => ({
      'x-goog-channel-id': channel,
      'x-goog-channel-token': token,
      'x-goog-resource-id': 'res' + uuid().slice(0, 6),
      'x-goog-resource-state': 'exists',
      'x-goog-message-number': '5',
    });
    const wrongMac = await postWebhook(
      hdr(`v.1.${Math.floor(Date.now() / 1000) + 3600}.${randomBytes(32).toString('hex')}`),
    );
    assert.equal(
      wrongMac.status,
      401,
      `wrong HMAC: ${wrongMac.status} ${wrongMac.text.slice(0, 120)}`,
    );
    const garbage = await postWebhook(hdr('not-a-token'));
    assert.ok([400, 401].includes(garbage.status), `malformed token: ${garbage.status}`);
    const noHeaders = await postWebhook({});
    assert.ok([400, 401].includes(noHeaders.status), `no Google headers: ${noHeaders.status}`);
    const badState = await postWebhook({
      ...hdr(`v.1.${Math.floor(Date.now() / 1000) + 3600}.${randomBytes(32).toString('hex')}`),
      'x-goog-resource-state': 'bogus',
    });
    assert.ok([400, 401].includes(badState.status), `bad resource state: ${badState.status}`);
    const after = await sql(`SELECT count(*)::int c FROM integration_core.inbound_message`).catch(
      () => ({ rows: [{ c: null }] }),
    );
    assert.equal(after.rows[0].c, before.rows[0].c, 'a refused push is not recorded');
  });
});
