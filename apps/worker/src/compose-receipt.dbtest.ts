// Real-database test (HEAAA-833, HEAAA-773 F-1): a stored (email|sms, delivery_receipt) inbound message is dispatched THROUGH the
// composed task table to the receipt handler and yields a `delivery_receipt` row; it is no longer marked `no_handler`.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55433/postgres node --test dist/compose-receipt.dbtest.js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, loadConfig } from '@ehr/kernel';
import { composeWorker } from './compose.js';
import type { PayloadOpener } from './jobs/integration-core/index.js';
import { createPool } from './runner.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dbName = `ehr_hearc833_${process.pid}_${Date.now()}`;
const ORG = '00000000-0000-7000-8000-0000000000a1';
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const KEY = randomBytes(32);
const seal = (plain: Buffer, ctx: string): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(ctx));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
// Test-only opener (the production KMS opener is C-01); same layout as the integration-core dbtest.
const opener: PayloadOpener = {
  open: (sealed, ctx) => {
    const d = createDecipheriv('aes-256-gcm', KEY, sealed.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(ctx));
    d.setAuthTag(sealed.subarray(12, 28));
    return Promise.resolve(Buffer.concat([d.update(sealed.subarray(28)), d.final()]));
  },
};

describe('composed worker dispatches stored delivery receipts (HEAAA-833)', () => {
  before(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(new URL(adminUrl).username, 'postgres'),
    });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const env = {
      PATH: process.env.PATH,
      EHR_DB_ADMIN_URL: urlFor(new URL(adminUrl).username),
      EHR_DB_MIGRATE_URL: urlFor('app_owner'),
    };
    for (const cmd of ['bootstrap', 'migrate'])
      execFileSync(process.execPath, [`${root}db/tools/migrate.mjs`, cmd], {
        env,
        stdio: 'inherit',
      });
    await installQueue(urlFor('app_owner'));
  });
  after(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(new URL(adminUrl).username, 'postgres'),
    });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  test('email and sms receipts reach the handler through compose and write a delivery_receipt row', async () => {
    const cfg = loadConfig({
      EHR_ENV: 'ci',
      EHR_DEPLOYABLE: 'worker',
      EHR_DATABASE_URL: urlFor('app_worker'),
      EHR_ORGANISATION_ID: ORG,
    });
    const log = createLogger({ sink: () => undefined });
    const pool = await createPool(cfg);
    const admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    admin.on('error', () => undefined);
    await admin.connect();
    try {
      const patientId = randomUUID();
      await admin.query(
        `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ('NY', $1, 'New York') ON CONFLICT DO NOTHING`,
        [ORG],
      );
      await admin.query(
        `INSERT INTO patient.patient (id, organisation_id, mrn, given_name, family_name, date_of_birth, state_code, created_via) VALUES ($1, $2, 'MRN-8100001', 'Fixture', 'Patient', '1980-01-01', 'NY', 'front_desk')`,
        [patientId, ORG],
      );
      await admin.query(
        `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'system', false)`,
        [ORG],
      );
      const { tasks } = await composeWorker({ cfg, pool, log, infra: { payloadOpener: opener } });
      const dispatch = tasks['integration_core.dispatch_inbound'];
      assert.ok(dispatch);
      for (const channel of ['email', 'sms'] as const) {
        const notificationId = randomUUID();
        const ref = `${channel}-provider-ref`;
        await admin.query(
          `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, variables, send_after, dedupe_key, status, sent_at, provider_message_id)
           VALUES ($1, $2, 'patient', $6, 'appointment_confirmation', 1, $3, '{}'::jsonb, now(), $4, 'sent', now(), $5)`,
          [notificationId, ORG, channel, `t:${notificationId}`, ref, patientId],
        );
        const messageId = randomUUID();
        const eventId = `ev-${channel}`;
        const body = JSON.stringify({
          providerMessageId: ref,
          eventId,
          status: 'delivered',
          occurredAt: new Date().toISOString(),
        });
        await admin.query(
          `INSERT INTO integration_core.inbound_message (id, organisation_id, source, event_id, message_type, payload) VALUES ($1,$2,$3,$4,'delivery_receipt',$5)`,
          [
            messageId,
            ORG,
            channel,
            eventId,
            seal(Buffer.from(body), `inbound:${channel}\n${eventId}`),
          ],
        );
        await (dispatch as (p: unknown, h: unknown) => Promise<void>)({ messageId }, {});
        const m = await admin.query(
          `SELECT status, handler FROM integration_core.inbound_message WHERE id = $1`,
          [messageId],
        );
        assert.equal(m.rows[0].status, 'handled');
        assert.equal(m.rows[0].handler, 'notifications.on_receipt');
        const r = await admin.query(
          `SELECT status FROM notifications.delivery_receipt WHERE notification_id = $1 AND vendor_event_id = $2`,
          [notificationId, eventId],
        );
        assert.equal(r.rowCount, 1);
        assert.equal(r.rows[0].status, 'delivered');
      }
    } finally {
      await admin.end();
      await pool.end();
    }
  });
});
