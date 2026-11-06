// Real-database tests for BE-06 (notifications, worker side) on PostgreSQL 17 with the real roles, migrations, queue and
// the BE-02 vendor gateway: the send job (render, recipient resolution with preferences, quiet hours, vendor failure and
// retry, no double send, merged patients), delivery receipts attaching to the survivor, the channel adapters, and the
// "no address, no text, no canary in logs or rows" checks. The provider is a recording test double: it proves our side of
// the interface, NOT a real provider (C-10/C-11 are not provisioned).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/jobs/notifications/notifications.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installQueue } from '@ehr/kernel/dist/queue/install.js';
import { createLogger, JobRegistry, KernelDb, Queue, syncTaskTypes } from '@ehr/kernel';
import { AdapterRegistry, VendorGateway } from '../integration-core/index.js';
import { AdapterFailure } from '../integration-core/index.js';
import {
  EmailAdapter,
  ProviderError,
  PushAdapter,
  SmsAdapter,
  type ProviderClient,
  type ProviderRequest,
} from './adapters.js';
import { defineNotificationsJobs } from './index.js';
import {
  applyCommunicationPreferences,
  type RecipientContributor,
  type ResolvedRecipient,
} from './recipient.js';
import { createReceiptHandler, parseReceipt, recordReceipt } from './receipt.js';
import { runSendMessage, type SendDeps } from './send-message.js';

const PG: string = 'pg';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg: any = (await import(PG)).default;
const adminUrl = process.env.EHR_TEST_ADMIN_URL;
if (!adminUrl) throw new Error('EHR_TEST_ADMIN_URL is not set');
let root = fileURLToPath(new URL('.', import.meta.url));
while (!existsSync(`${root}db/tools/migrate.mjs`)) root = join(root, '..') + '/';
const dbName = `ehr_be06_w_${process.pid}_${Date.now()}`;
const urlFor = (user: string, database = dbName): string => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = '';
  u.pathname = `/${database}`;
  return u.toString();
};

const ORG = '00000000-0000-7000-8000-0000000000a1';
const P1 = '00000000-0000-7000-8000-0000000000e1';
const P2 = '00000000-0000-7000-8000-0000000000e2'; // survivor of P1
const PRINCIPAL = '00000000-0000-7000-8000-0000000000c9';
const LINK = 'https://portal.example.test/appointments';
const ADDR = {
  email: 'pat.one@example.test',
  phone: '+15550100123',
  push: 'push-subscription-ref-001',
};
const ADDR2 = { email: 'pat.two@example.test', phone: '+15550100456' };
let seq = 0;
const nid = (): string => `00000000-0000-7000-8000-00000000d${String(++seq).padStart(3, '0')}`;

/** A recording provider. `plan` decides each call; the log keeps what we sent so the test can inspect the wire shape. */
class FakeProvider implements ProviderClient {
  calls: ProviderRequest[] = [];
  plan: (n: number, req: ProviderRequest) => { messageId: string } | ProviderError = (n) => ({
    messageId: `prov-${n}`,
  });
  /** Runs inside the vendor call (a merge landing while the message is in flight). */
  during: (() => Promise<void>) | undefined;
  async send(req: ProviderRequest): Promise<{ messageId: string; httpStatus: number }> {
    this.calls.push(req);
    const hook = this.during;
    this.during = undefined;
    await hook?.();
    const r = this.plan(this.calls.length, req);
    if (r instanceof ProviderError) throw r;
    return { messageId: r.messageId, httpStatus: 202 };
  }
  health(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
  reset(): void {
    this.calls = [];
    this.plan = (n) => ({ messageId: `prov-${n}` });
  }
}

describe('notifications on PostgreSQL 17 (BE-06, worker side)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wpool: any;
  let db: KernelDb;
  const logs: string[] = [];
  const log = createLogger({ sink: (l) => logs.push(l), level: 'debug' });
  const registry = new JobRegistry();
  defineNotificationsJobs(registry);
  registry.defineJob({
    name: 'probe.on_delivery_failed',
    maxAttempts: 1,
    onMerged: 'none',
    carriesPatientIds: false,
    jobScope: 'org',
    jobClass: 'handler',
  });
  registry.registerHandler('notifications.delivery_failed', 'probe');
  const queue = new Queue(registry, 'worker');
  const provider = new FakeProvider();
  // undefined = the real clock (a stale fixed instant made rows look not yet due when setup took over a second)
  let clockNow: Date | undefined;
  let prefs: Record<
    string,
    {
      channels: ('email' | 'sms' | 'push' | 'in_app')[];
      language: string;
      contacts: Record<string, string>;
      active?: boolean;
      quiet?: ResolvedRecipient['quietHours'];
    }
  > = {};
  let onResolve: (() => Promise<void>) | undefined;
  const patientContributor: RecipientContributor = {
    resolve: async (_tx, id) => {
      const hook = onResolve;
      onResolve = undefined;
      await hook?.();
      const p = prefs[id];
      if (p === undefined) return undefined;
      const r = applyCommunicationPreferences(p.contacts, {
        channels: p.channels,
        language: p.language,
      });
      return {
        active: p.active ?? true,
        language: p.language,
        ...r,
        ...(p.quiet === undefined ? {} : { quietHours: p.quiet }),
      };
    },
  };
  const principalContributor: RecipientContributor = {
    resolve: (_tx, id) =>
      Promise.resolve(
        id === PRINCIPAL
          ? {
              active: true,
              language: 'en',
              permitted: [
                { channel: 'email', address: 'staff@example.test' },
                { channel: 'in_app' },
              ],
              withheld: [],
            }
          : undefined,
      ),
  };
  const survivors = new Map<string, string>([[P1, P2]]);
  const deps = (): SendDeps => ({
    db,
    orgId: ORG,
    queue,
    gateway: undefined as unknown as VendorGateway,
    recipients: { patient: patientContributor, principal: principalContributor },
    log,
    survivorOf: (id: string) => Promise.resolve(survivors.get(id)),
    now: () => clockNow ?? new Date(),
  });
  let gw: VendorGateway;
  const run = (
    id: string,
    patientId: string | undefined,
    attempt = { number: 1, max: 8 },
    over: Partial<SendDeps> = {},
  ) =>
    runSendMessage(
      { ...deps(), gateway: gw, ...over },
      patientId === undefined ? { notificationId: id } : { notificationId: id, patientId },
      attempt,
    );

  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, p)).rows as T[];
  const row = async (id: string) =>
    (
      await q<Record<string, unknown>>(`SELECT * FROM notifications.notification WHERE id = $1`, [
        id,
      ])
    )[0] as Record<string, unknown>;

  async function addTemplate(
    key: string,
    version: number,
    channel: string,
    language: string,
    subject: string | null,
    body: string,
    variables: { name: string; type: string }[],
    status = 'published',
  ): Promise<void> {
    await admin.query(
      `INSERT INTO notifications.template (id, organisation_id, key, channel, language, version, subject, body, variables, status, render_check_passed_at, published_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'draft', NULL, NULL)`,
      [ORG, key, channel, language, version, subject, body, JSON.stringify(variables)],
    );
    if (status === 'draft') return;
    await admin.query(
      `UPDATE notifications.template SET render_check_passed_at = now() WHERE key = $1 AND version = $2 AND channel = $3 AND language = $4`,
      [key, version, channel, language],
    );
    await admin.query(
      `UPDATE notifications.template SET status = $5, published_at = now() WHERE key = $1 AND version = $2 AND channel = $3 AND language = $4`,
      [key, version, channel, language, status],
    );
  }
  const V = (...n: string[]) =>
    n.map((name) => ({
      name,
      type: {
        start_at: 'datetime',
        end_at: 'datetime',
        time_zone: 'timezone',
        location_name: 'location_name',
        portal_link: 'url',
        event_uid: 'uid',
      }[name] as string,
    }));
  const VALUES = {
    start_at: '2030-01-15T14:30:00.000Z',
    end_at: '2030-01-15T15:00:00.000Z',
    time_zone: 'America/New_York',
    location_name: 'Riverside Clinic',
    portal_link: LINK,
    event_uid: '00000000-0000-4000-8000-000000000001',
  };

  async function notification(o: {
    patient?: string | null;
    principal?: string | null;
    channel: string;
    key?: string;
    version?: number;
    variables?: object;
    sendAfter?: Date;
    status?: string;
  }): Promise<string> {
    const id = nid();
    await admin.query(
      `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, variables, send_after, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        id,
        ORG,
        o.principal ? 'principal' : 'patient',
        o.patient ?? null,
        o.principal ?? null,
        o.key ?? 'appointment_confirmation',
        o.version ?? 1,
        o.channel,
        JSON.stringify(o.variables ?? VALUES),
        o.sendAfter ?? new Date(Date.now() - 1000),
        `t:${id}`,
      ],
    );
    return id;
  }

  before(async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`CREATE DATABASE ${dbName}`);
    await a.end();
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
    const w = new pg.Client({ connectionString: urlFor('app_worker') });
    await w.connect();
    await syncTaskTypes(w, registry);
    await w.end();
    admin = new pg.Client({ connectionString: urlFor(new URL(adminUrl).username) });
    await admin.connect();
    wpool = new pg.Pool({ connectionString: urlFor('app_worker'), max: 6 });
    wpool.on('error', () => undefined);
    db = new KernelDb(wpool);
    for (const [kind, vendor] of [
      ['email', 'testmail'],
      ['sms', 'testsms'],
      ['push', 'testpush'],
    ])
      await admin.query(
        `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, enabled) VALUES (gen_random_uuid(), $1, $2, $3, true)`,
        [ORG, kind, vendor],
      );
    const adapters = new AdapterRegistry();
    adapters.register(new EmailAdapter(provider));
    adapters.register(new SmsAdapter(provider));
    adapters.register(new PushAdapter(provider));
    gw = new VendorGateway({
      db,
      orgId: ORG,
      adapters,
      credentials: () => ({ get: () => Promise.resolve('x') }),
      sleep: () => Promise.resolve(),
      logger: log,
      maxAttempts: 2,
    });

    // appointment_confirmation v1: every channel, English; the .ics travels with the e-mail.
    const k = 'appointment_confirmation';
    await addTemplate(
      k,
      1,
      'email',
      'en',
      'Your appointment is confirmed',
      'Appointment at {{location_name}} on {{start_at}}. Sign in: {{portal_link}}',
      V('location_name', 'start_at', 'portal_link', 'time_zone'),
    );
    await addTemplate(
      k,
      1,
      'email',
      'es',
      'Su cita esta confirmada',
      'Cita en {{location_name}} el {{start_at}}. Ingrese: {{portal_link}}',
      V('location_name', 'start_at', 'portal_link', 'time_zone'),
    );
    await addTemplate(
      k,
      1,
      'sms',
      'en',
      null,
      'Appointment {{start_at}}. Sign in: {{portal_link}}',
      V('start_at', 'portal_link', 'time_zone'),
    );
    await addTemplate(
      k,
      1,
      'push',
      'en',
      'Appointment',
      'Confirmed for {{start_at}}',
      V('start_at', 'time_zone'),
    );
    await addTemplate(
      k,
      1,
      'in_app',
      'en',
      null,
      'Your appointment is confirmed for {{start_at}}',
      V('start_at', 'time_zone'),
    );
    await addTemplate(
      k,
      1,
      'ics',
      'en',
      null,
      'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:{{event_uid}}\nDTSTART:{{start_at}}\nDTEND:{{end_at}}\nLOCATION:{{location_name}}\nSUMMARY:Appointment\nEND:VEVENT\nEND:VCALENDAR\n',
      V('event_uid', 'start_at', 'end_at', 'location_name'),
    );
  });
  after(async () => {
    await wpool?.end();
    await admin?.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  });

  describe('the send job', () => {
    test("e-mail: renders the published version in the person's language, attaches the .ics, stores the vendor reference and no address or text", async () => {
      prefs = { [P1]: { channels: ['email', 'sms', 'push'], language: 'en', contacts: ADDR } };
      provider.reset();
      const id = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(id, P1), 'sent');
      assert.equal(provider.calls.length, 1);
      const c = provider.calls[0] as ProviderRequest;
      assert.equal(c.to, ADDR.email);
      assert.equal(c.subject, 'Your appointment is confirmed');
      assert.match(
        c.text,
        /^Appointment at Riverside Clinic on Jan 15, 2030, 9:30\sAM\. Sign in: https:\/\/portal\.example\.test\/appointments$/,
      );
      assert.equal(c.attachments?.length, 1);
      const ics = c.attachments?.[0];
      assert.equal(ics?.filename, 'appointment.ics');
      assert.match(ics?.contentType ?? '', /^text\/calendar/);
      assert.match(ics?.content ?? '', /^BEGIN:VCALENDAR\r\n/);
      assert.match(ics?.content ?? '', /DTSTART:20300115T143000Z\r\n/);
      assert.equal(c.idempotencyToken, `n-${id}`);
      const n = await row(id);
      assert.equal(n['status'], 'sent');
      assert.equal(n['provider_message_id'], 'prov-1');
      assert.equal(n['language'], 'en');
      assert.equal(n['attempts'], 1);
      assert.notEqual(n['sent_at'], null);
      assert.equal(JSON.stringify(n).includes(ADDR.email), false, 'no address in the row');
      assert.equal(JSON.stringify(n).includes('Sign in'), false, 'no message text in the row');
      // The call log holds IDs and an outcome, never an address or text.
      const calls = await q<Record<string, unknown>>(
        `SELECT * FROM integration_core.outbound_call WHERE correlation_id = $1`,
        [id],
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.['outcome'], 'ok');
      assert.equal(JSON.stringify(calls).includes(ADDR.email), false);
      // A repeat of the same job (queue retry after the success was committed) sends nothing.
      assert.equal(await run(id, P1), 'already_final');
      assert.equal(provider.calls.length, 1, 'no double send');
    });

    test("language: the person's language when published, else the default; SMS and push render without a subject/with a title", async () => {
      prefs = { [P1]: { channels: ['email', 'sms', 'push'], language: 'es', contacts: ADDR } };
      provider.reset();
      const em = await notification({ patient: P1, channel: 'email' });
      const sm = await notification({ patient: P1, channel: 'sms' }); // no Spanish SMS template: falls back to English
      const pu = await notification({ patient: P1, channel: 'push' });
      assert.deepEqual(
        [await run(em, P1), await run(sm, P1), await run(pu, P1)],
        ['sent', 'sent', 'sent'],
      );
      assert.match(provider.calls[0]?.text ?? '', /^Cita en Riverside Clinic/);
      assert.match(provider.calls[1]?.text ?? '', /^Appointment /);
      assert.equal(provider.calls[1]?.to, ADDR.phone);
      assert.equal(provider.calls[2]?.subject, 'Appointment');
      assert.equal(provider.calls[2]?.to, ADDR.push);
      assert.equal((await row(sm))['language'], 'es');
    });

    test('TC-NT-08: SMS off and e-mail on - the SMS is suppressed with its reason and the provider is never called; e-mail is sent', async () => {
      prefs = { [P1]: { channels: ['email'], language: 'en', contacts: ADDR } };
      provider.reset();
      const sms = await notification({ patient: P1, channel: 'sms' });
      const mail = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(sms, P1), 'suppressed');
      assert.equal(await run(mail, P1), 'sent');
      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0]?.to, ADDR.email);
      const n = await row(sms);
      assert.equal(n['status'], 'suppressed');
      assert.equal(n['suppress_reason'], 'preference_off');
      assert.equal(await run(sms, P1), 'already_final');
    });

    test('suppression reasons: no address, unknown recipient, inactive patient, no contributor, no template', async () => {
      provider.reset();
      prefs = {
        [P1]: { channels: ['email', 'sms'], language: 'en', contacts: { email: ADDR.email } },
      };
      const noAddr = await notification({ patient: P1, channel: 'sms' });
      assert.equal(await run(noAddr, P1), 'suppressed');
      assert.equal((await row(noAddr))['suppress_reason'], 'no_address');
      const unknown = await notification({
        patient: '00000000-0000-7000-8000-0000000000e7',
        channel: 'email',
      });
      assert.equal(await run(unknown, '00000000-0000-7000-8000-0000000000e7'), 'suppressed');
      assert.equal((await row(unknown))['suppress_reason'], 'no_recipient');
      prefs = { [P1]: { channels: ['email'], language: 'en', contacts: ADDR, active: false } };
      const inactive = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(inactive, P1), 'suppressed');
      assert.equal((await row(inactive))['suppress_reason'], 'patient_inactive');
      prefs = { [P1]: { channels: ['email'], language: 'en', contacts: ADDR } };
      const noContributor = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(noContributor, P1, undefined, { recipients: {} }), 'suppressed');
      assert.equal((await row(noContributor))['suppress_reason'], 'no_recipient');
      const noTemplate = await notification({ patient: P1, channel: 'email', key: 'unknown_key' });
      assert.equal(await run(noTemplate, P1), 'suppressed');
      assert.equal((await row(noTemplate))['suppress_reason'], 'no_template');
      assert.equal(provider.calls.length, 0);
    });

    test('in-app notices need no vendor and are sent even when every external channel is off (TC-NT-04)', async () => {
      prefs = { [P1]: { channels: [], language: 'en', contacts: {} } };
      provider.reset();
      const id = await notification({ patient: P1, channel: 'in_app' });
      assert.equal(await run(id, P1), 'sent');
      assert.equal(provider.calls.length, 0);
      assert.equal((await row(id))['status'], 'sent');
    });

    test('TC-NT-04: a failing provider is retried by the queue; the failure is an error CLASS; the last attempt publishes delivery_failed; recovery sends with the same token', async () => {
      prefs = { [P1]: { channels: ['email', 'sms'], language: 'en', contacts: ADDR } };
      provider.reset();
      provider.plan = () => new ProviderError(true, 503, 'provider_unavailable');
      const id = await notification({ patient: P1, channel: 'sms' });
      await assert.rejects(
        run(id, P1, { number: 1, max: 8 }),
        (e: { code?: string }) => e.code === 'integration.vendor_unavailable',
      );
      let n = await row(id);
      assert.equal(n['status'], 'failed');
      assert.equal(n['error_class'], 'vendor_exhausted');
      assert.equal(n['attempts'], 1);
      assert.equal(provider.calls.length, 2, 'the gateway retried within the job (maxAttempts 2)');
      assert.equal(
        new Set(provider.calls.map((c) => c.idempotencyToken)).size,
        1,
        'the same token on every attempt',
      );
      const failedJobs = async () =>
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'probe.on_delivery_failed'`,
            )
          )[0]?.['n'],
        );
      assert.equal(await failedJobs(), 0, 'not the last attempt yet');
      await assert.rejects(
        run(id, P1, { number: 8, max: 8 }),
        (e: { code?: string }) => e.code === 'integration.vendor_unavailable',
      );
      assert.equal(
        await failedJobs(),
        1,
        'the last attempt published delivery_failed (operations view)',
      );
      assert.equal((await row(id))['attempts'], 2);
      // The provider recovers: the next queue retry sends and clears nothing else.
      provider.reset();
      const token = `n-${id}`;
      assert.equal(await run(id, P1, { number: 2, max: 8 }), 'sent');
      assert.equal(provider.calls[0]?.idempotencyToken, token);
      n = await row(id);
      assert.equal(n['status'], 'sent');
      assert.equal(n['error_class'], null);
      // The in-app notice for the same event was never affected by the provider.
      const inApp = await notification({ patient: P1, channel: 'in_app' });
      assert.equal(await run(inApp, P1), 'sent');
    });

    test('a vendor refusal (4xx) is final: failed, no queue retry, delivery_failed published', async () => {
      prefs = { [P1]: { channels: ['email'], language: 'en', contacts: ADDR } };
      provider.reset();
      provider.plan = () => new ProviderError(false, 400, 'bad_request');
      const id = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(id, P1), 'failed');
      const n = await row(id);
      assert.equal(n['status'], 'failed');
      assert.equal(n['error_class'], 'vendor_rejected');
      assert.equal(provider.calls.length, 1);
    });

    test('quiet hours defer the send to when they end, restore the attempt count and queue the job', async () => {
      prefs = {
        [P1]: {
          channels: ['email'],
          language: 'en',
          contacts: ADDR,
          quiet: { start: '22:00', end: '07:00', timeZone: 'America/New_York' },
        },
      };
      provider.reset();
      clockNow = new Date('2030-01-16T03:00:00Z'); // 22:00 in New York
      const id = await notification({ patient: P1, channel: 'email' });
      assert.equal(await run(id, P1), 'deferred');
      const n = await row(id);
      assert.equal(n['status'], 'queued');
      assert.equal(n['attempts'], 0);
      assert.equal((n['send_after'] as Date).toISOString(), '2030-01-16T12:00:00.000Z');
      assert.equal(provider.calls.length, 0);
      const job = (
        await q<{ run_at: Date; payload: { notificationId: string } }>(
          `SELECT j.run_at, j.payload FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'notifications.send_message' AND j.payload->>'notificationId' = $1`,
          [id],
        )
      )[0];
      assert.equal(job?.run_at.toISOString(), '2030-01-16T12:00:00.000Z');
      // Not yet due: a job that runs early waits and re-queues itself.
      assert.equal(await run(id, P1), 'deferred');
      clockNow = new Date('2030-01-16T12:00:01Z');
      assert.equal(await run(id, P1), 'sent');
      assert.equal(provider.calls.length, 1);
      clockNow = undefined;
    });

    test('a template that leaks text is stopped at send time by the output scan; the provider is never called', async () => {
      prefs = { [P1]: { channels: ['email', 'sms'], language: 'en', contacts: ADDR } };
      provider.reset();
      // A row inserted past the render check (triggers off, as a repair script might): the send-time scan is the last line.
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(
        `INSERT INTO notifications.template (id, organisation_id, key, channel, language, version, body, variables, status, render_check_passed_at, published_at)
                         VALUES (gen_random_uuid(), $1, 'leaky', 'sms', 'en', 1, 'Your HIV test result is ready: {{portal_link}}', $2::jsonb, 'published', now(), now())`,
        [ORG, JSON.stringify(V('portal_link'))],
      );
      await admin.query(`SET session_replication_role = DEFAULT`);
      const id = await notification({
        patient: P1,
        channel: 'sms',
        key: 'leaky',
        variables: { portal_link: LINK },
      });
      assert.equal(await run(id, P1), 'failed');
      assert.equal((await row(id))['error_class'], 'phi_guard');
      assert.equal(provider.calls.length, 0);
    });

    test('a render error (a declared value missing) is a final failure, not a retry', async () => {
      prefs = { [P1]: { channels: ['sms'], language: 'en', contacts: ADDR } };
      provider.reset();
      const id = await notification({
        patient: P1,
        channel: 'sms',
        variables: { start_at: VALUES.start_at },
      });
      assert.equal(await run(id, P1), 'failed');
      assert.equal((await row(id))['error_class'], 'render_missing_variable');
      assert.equal(provider.calls.length, 0);
    });

    test('BE06-F1: a merge that re-points the row during the vendor call - sent, failed and deferred outcomes are still recorded (under the survivor)', async () => {
      prefs = {
        [P1]: { channels: ['email'], language: 'en', contacts: ADDR },
        [P2]: { channels: ['email'], language: 'en', contacts: ADDR2 },
      };
      const repoint = (id: string) => async (): Promise<void> => {
        await admin.query(`UPDATE notifications.notification SET patient_id = $2 WHERE id = $1`, [
          id,
          P2,
        ]);
      };
      // sent
      provider.reset();
      const a = await notification({ patient: P1, channel: 'email' });
      provider.during = repoint(a);
      assert.equal(await run(a, P1), 'sent');
      let n = await row(a);
      assert.equal(n['status'], 'sent');
      assert.equal(n['provider_message_id'], 'prov-1');
      // failed (vendor refusal)
      provider.reset();
      provider.plan = () => new ProviderError(false, 400, 'bad_request');
      const b = await notification({ patient: P1, channel: 'email' });
      provider.during = repoint(b);
      assert.equal(await run(b, P1), 'failed');
      n = await row(b);
      assert.equal(n['status'], 'failed');
      assert.equal(n['error_class'], 'vendor_rejected');
      // deferred (quiet hours; merge between claim and the deferral write)
      provider.reset();
      prefs[P1] = {
        channels: ['email'],
        language: 'en',
        contacts: ADDR,
        quiet: { start: '22:00', end: '07:00', timeZone: 'America/New_York' },
      };
      clockNow = new Date('2030-01-16T03:00:00Z');
      const c = await notification({ patient: P1, channel: 'email' });
      onResolve = repoint(c);
      assert.equal(await run(c, P1), 'deferred');
      n = await row(c);
      assert.equal(n['status'], 'queued');
      assert.equal(provider.calls.length, 0);
      clockNow = undefined;
    });

    test("a patient merged while the job waited: the job follows the survivor and sends to the survivor's contacts (on_merged = resolve)", async () => {
      prefs = {
        [P1]: { channels: ['email'], language: 'en', contacts: ADDR },
        [P2]: { channels: ['email'], language: 'en', contacts: ADDR2 },
      };
      provider.reset();
      const id = await notification({ patient: P2, channel: 'email' }); // re-pointed to the survivor by the merge
      assert.equal(await run(id, P1), 'sent', 'the payload still names the merged ID');
      assert.equal(provider.calls[0]?.to, ADDR2.email);
      const other = await notification({ patient: P2, channel: 'email' });
      assert.equal(
        await run(other, P1, undefined, { survivorOf: undefined }),
        'gone',
        'without the survivor lookup the merged scope sees nothing and writes nothing',
      );
      assert.equal((await row(other))['status'], 'queued');
    });

    test('a staff notice runs under the organisation scope and resolves through the principal contributor', async () => {
      provider.reset();
      const id = await notification({ principal: PRINCIPAL, channel: 'email' });
      assert.equal(await run(id, undefined), 'sent');
      assert.equal(provider.calls[0]?.to, 'staff@example.test');
    });

    test('no address, message text or canary reaches a log line', () => {
      const all = logs.join('\n');
      for (const secret of [
        ADDR.email,
        ADDR.phone,
        ADDR.push,
        ADDR2.email,
        'staff@example.test',
        'Riverside',
        'Sign in:',
      ])
        assert.equal(all.includes(secret), false, secret);
    });
  });

  describe('delivery receipts (33.1 notifications.on_receipt, SBR-16)', () => {
    const MSG = 'prov-receipt-1';
    const body = (o: Record<string, unknown>): Buffer =>
      Buffer.from(
        JSON.stringify({
          providerMessageId: MSG,
          eventId: 'ev-1',
          status: 'delivered',
          occurredAt: '2030-01-15T14:31:00Z',
          ...o,
        }),
      );
    const ctx = () => ({ db, orgId: ORG, log });
    let sentId: string;

    before(async () => {
      sentId = await notification({ patient: P1, channel: 'sms' });
      await admin.query(
        `UPDATE notifications.notification SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`,
        [sentId, MSG],
      );
    });

    test('a receipt for a kept notification of a merged patient attaches to the SURVIVOR; a repeat of the event is a no-op', async () => {
      const deps = { survivorOf: (id: string) => Promise.resolve(survivors.get(id)) };
      assert.equal(await recordReceipt(deps, ctx(), body({})), 'recorded');
      assert.equal(await recordReceipt(deps, ctx(), body({})), 'duplicate');
      const r = await q<Record<string, unknown>>(
        `SELECT * FROM notifications.delivery_receipt WHERE notification_id = $1`,
        [sentId],
      );
      assert.equal(r.length, 1);
      assert.equal(r[0]?.['patient_id'], P2);
      assert.equal(r[0]?.['status'], 'delivered');
      assert.equal(
        (await row(sentId))['patient_id'],
        P1,
        'the kept notification stays on the merged ID',
      );
      // A later bounce is a NEW row (receipts are never updated).
      assert.equal(
        await recordReceipt(deps, ctx(), body({ eventId: 'ev-2', status: 'bounced' })),
        'recorded',
      );
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.delivery_receipt WHERE notification_id = $1`,
              [sentId],
            )
          )[0]?.['n'],
        ),
        2,
      );
      // Without a survivor lookup the notification's own patient ID is used.
      assert.equal(await recordReceipt({}, ctx(), body({ eventId: 'ev-3' })), 'recorded');
      assert.equal(
        (
          await q(
            `SELECT patient_id FROM notifications.delivery_receipt WHERE vendor_event_id = 'ev-3'`,
          )
        )[0]?.['patient_id'],
        P1,
      );
    });

    test('untrusted payloads: unknown reference, bad shape, bad status, oversized and ambiguous references record nothing', async () => {
      const before = Number(
        (await q(`SELECT count(*)::int AS n FROM notifications.delivery_receipt`))[0]?.['n'],
      );
      assert.equal(
        await recordReceipt({}, ctx(), body({ providerMessageId: 'never-sent' })),
        'unknown_reference',
      );
      assert.equal(await recordReceipt({}, ctx(), Buffer.from('not json')), 'invalid');
      assert.equal(
        await recordReceipt({}, ctx(), body({ status: 'opened-and-clicked' })),
        'invalid',
      );
      assert.equal(await recordReceipt({}, ctx(), body({ occurredAt: 'yesterday' })), 'invalid');
      assert.equal(await recordReceipt({}, ctx(), body({ eventId: '' })), 'invalid');
      assert.equal(await recordReceipt({}, ctx(), Buffer.alloc(9000, 'a')), 'invalid');
      assert.equal(await recordReceipt({}, ctx(), Buffer.from('[1,2]')), 'invalid');
      // A reference that matches a notification that was never SENT is unknown (a forged receipt cannot create history).
      const queuedId = await notification({ patient: P1, channel: 'sms' });
      await admin.query(
        `UPDATE notifications.notification SET provider_message_id = 'queued-ref' WHERE id = $1`,
        [queuedId],
      );
      assert.equal(
        await recordReceipt({}, ctx(), body({ providerMessageId: 'queued-ref' })),
        'unknown_reference',
      );
      // Two sent notifications sharing one reference are ambiguous: dropped, not guessed.
      for (let i = 0; i < 2; i++) {
        const dup = await notification({ patient: P1, channel: 'sms' });
        await admin.query(
          `UPDATE notifications.notification SET status = 'sent', sent_at = now(), provider_message_id = 'dup-ref' WHERE id = $1`,
          [dup],
        );
      }
      assert.equal(
        await recordReceipt({}, ctx(), body({ providerMessageId: 'dup-ref' })),
        'unknown_reference',
      );
      assert.equal(
        Number(
          (await q(`SELECT count(*)::int AS n FROM notifications.delivery_receipt`))[0]?.['n'],
        ),
        before,
      );
      assert.equal(parseReceipt(body({})) !== undefined, true);
    });

    test('the inbound handler records through the same path', async () => {
      const handler = createReceiptHandler({
        survivorOf: (id) => Promise.resolve(survivors.get(id)),
      });
      await handler(
        {
          id: nid(),
          source: 'testmail',
          eventId: 'x',
          messageType: 'delivery_receipt',
          receivedAt: new Date(),
          body: body({ eventId: 'ev-via-handler' }),
        },
        { db, orgId: ORG, queue, log },
      );
      assert.equal(
        Number(
          (
            await q(
              `SELECT count(*)::int AS n FROM notifications.delivery_receipt WHERE vendor_event_id = 'ev-via-handler'`,
            )
          )[0]?.['n'],
        ),
        1,
      );
    });

    test('the worker role cannot update or delete a receipt, or write one for a patient outside its job scope', async () => {
      await assert.rejects(
        db.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, (tx) =>
          tx.query(`UPDATE notifications.delivery_receipt SET status = 'failed'`),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        db.withScope({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }, (tx) =>
          tx.query(`DELETE FROM notifications.delivery_receipt`),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      await assert.rejects(
        db.withScope(
          {
            audience: 'system',
            realm: 'worker',
            orgId: ORG,
            jobScope: 'patients',
            jobPatientIds: [P2],
          },
          (tx) =>
            tx.query(
              `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id) VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', now(), 'out-of-scope')`,
              [ORG, sentId, P1],
            ),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
    });
  });

  describe('channel adapters implement the BE-02 interface', () => {
    const conn = { id: 'c', kind: 'email', vendor: 'v', settings: {} };
    const creds = { get: () => Promise.resolve('x') };
    const call = (a: { call: (r: never) => Promise<unknown> }, args: Record<string, unknown>) =>
      a.call({
        operation: 'send',
        args,
        connection: conn,
        credentials: creds,
        idempotencyToken: 'tok-12345678',
        signal: new AbortController().signal,
      } as never);

    test('argument checks reject header injection, malformed addresses and oversize text without echoing them', async () => {
      const mail = new EmailAdapter(provider);
      const bad: Record<string, unknown>[] = [
        { to: 'a@example.test', subject: 'x\r\nBcc: evil@example.test', text: 't' },
        { to: 'a@example.test\r\nBcc: e@example.test', subject: 's', text: 't' },
        { to: 'not-an-address', subject: 's', text: 't' },
        { to: 'a@example.test', subject: 's', text: 'x'.repeat(20001) },
        {
          to: 'a@example.test',
          subject: 's',
          text: 't',
          attachments: [{ filename: '../etc/passwd', contentType: 'text/calendar', content: 'x' }],
        },
      ];
      for (const b of bad)
        await assert.rejects(
          call(mail, b),
          (e: AdapterFailure) =>
            e instanceof AdapterFailure &&
            e.retryable === false &&
            e.errorClass === 'bad_arguments' &&
            !JSON.stringify(e).includes('evil'),
        );
      const sms = new SmsAdapter(provider);
      await assert.rejects(
        call(sms, { to: '5550100', text: 't' }),
        (e: AdapterFailure) => e.errorClass === 'bad_arguments',
      );
      await assert.rejects(
        call(sms, { to: '+15550100123', text: 'x'.repeat(481) }),
        (e: AdapterFailure) => e.errorClass === 'bad_arguments',
      );
      await assert.rejects(
        call(new PushAdapter(provider), { to: 'ref', text: 'x'.repeat(179) }),
        (e: AdapterFailure) => e.errorClass === 'bad_arguments',
      );
      await assert.rejects(
        mail.call({
          operation: 'lookup',
          args: {},
          connection: conn,
          credentials: creds,
          idempotencyToken: 'tok-12345678',
          signal: new AbortController().signal,
        } as never),
        (e: AdapterFailure) => e.errorClass === 'unsupported_operation',
      );
    });

    test("provider errors map to AdapterFailure with the provider's retryability; any other exception is retryable; health never throws", async () => {
      const mail = new EmailAdapter(provider);
      provider.reset();
      provider.plan = () => new ProviderError(false, 422, 'rejected');
      await assert.rejects(
        call(mail, { to: 'a@example.test', subject: 's', text: 't' }),
        (e: AdapterFailure) =>
          e.retryable === false && e.httpStatus === 422 && e.errorClass === 'rejected',
      );
      provider.plan = () => {
        throw new Error('socket hang up to https://secret.example.test with token ABC');
      };
      await assert.rejects(
        call(mail, { to: 'a@example.test', subject: 's', text: 't' }),
        (e: AdapterFailure) =>
          e.retryable === true &&
          e.errorClass === 'provider_exception' &&
          !JSON.stringify(e).includes('ABC') &&
          !String(e.message).includes('secret'),
      );
      assert.equal(mail.supportsIdempotencyToken, true);
      assert.deepEqual(
        [mail.kind, new SmsAdapter(provider).kind, new PushAdapter(provider).kind],
        ['email', 'sms', 'push'],
      );
      const h = await mail.healthCheck({
        connection: conn,
        credentials: creds,
        signal: new AbortController().signal,
      } as never);
      assert.equal(h.ok, true);
      provider.reset();
    });
  });
});
