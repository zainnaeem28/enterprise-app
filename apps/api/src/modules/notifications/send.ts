// `notifications.send` and `cancel` (ARCHITECTURE 24, 22.13; SHARED-BOUNDARIES 8.3 BD-10, 3.2 rule 7).
//   send(templateKey, recipientRef, variables, dedupeKey, sendAfter)
//     * validates the variables against the allowlist (names AND per-type values) and scans them for condition-revealing
//       text, so a free-text field of another module can never reach a message (TC-NT-06);
//     * inserts one QUEUED `notification` row per channel of the latest published version, in the CALLER's transaction,
//       and enqueues `notifications.send_message` in the same transaction (outbox, 21.8);
//     * a repeated dedupe key does nothing (UQ organisation + key): no second row, no second job, no second message.
//   The job renders, resolves the address (rule 7) and calls the vendor. No address and no message text is stored here.
import type { Queue, Tx } from '@ehr/kernel';
import { VARIABLE_ALLOWLIST, normaliseValue, type ValueOptions } from './allowlist.js';
import { NotificationsValidationError } from './errors.js';
import { findForbidden } from './forbidden.js';
import { uuidv7 } from './ids.js';
import { parseRecipientRef, type DeliveryChannel } from './recipient.js';

const KEY = /^[a-z][a-z0-9_.]{0,80}$/;
const DEDUPE = /^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)+$/;
const PREFIX = /^[a-z][a-z0-9_]*:[A-Za-z0-9_.:-]+$/;

export interface SendRequest {
  templateKey: string;
  /** `patient:<uuid>` or `principal:<uuid>`. Never an address. */
  recipientRef: string;
  /** Only allowlisted names; every name the template declares must be present. */
  variables: Readonly<Record<string, unknown>>;
  /** Names the resource and the purpose, e.g. `reminder:<reservation>:48h`. Never contains the recipient's ID. */
  dedupeKey: string;
  sendAfter?: Date;
}

export interface SendResult {
  /** Rows created now. */
  created: { notificationId: string; channel: DeliveryChannel }[];
  /** Channels whose dedupe key already existed: nothing was created or queued for them. */
  duplicates: DeliveryChannel[];
}

export interface NotificationDeps {
  queue: Queue;
  /** Deployment portal hosts; links must point at one of them. */
  allowedLinkHosts?: readonly string[];
  /** Deployment terms (internal service names, clinician display names) that no value may contain. */
  forbiddenTerms?: (tx: Tx) => Promise<readonly string[]>;
}

type Row = Record<string, unknown>;

export class NotificationService {
  constructor(private readonly d: NotificationDeps) {}

  async send(tx: Tx, req: SendRequest): Promise<SendResult> {
    const bad: string[] = [];
    if (!KEY.test(req.templateKey)) bad.push('templateKey');
    const ref = parseRecipientRef(req.recipientRef);
    if (ref === undefined) bad.push('recipientRef');
    if (!DEDUPE.test(req.dedupeKey) || req.dedupeKey.length > 150) bad.push('dedupeKey');
    else if (ref !== undefined && req.dedupeKey.toLowerCase().includes(ref.id))
      bad.push('dedupeKey'); // 22.13
    if (req.sendAfter !== undefined && Number.isNaN(req.sendAfter.getTime())) bad.push('sendAfter');
    if (typeof req.variables !== 'object' || req.variables === null || Array.isArray(req.variables))
      bad.push('variables');
    if (bad.length > 0 || ref === undefined) throw new NotificationsValidationError(bad);

    const values = await this.cleanValues(tx, req.variables);

    const tpl = await tx.query(
      `SELECT channel, version, variables FROM notifications.template
        WHERE key = $1 AND status = 'published'
          AND version = (SELECT max(version) FROM notifications.template WHERE key = $1 AND status = 'published')`,
      [req.templateKey],
    );
    if (tpl.rows.length === 0) throw new NotificationsValidationError(['templateKey']);
    const version = Number((tpl.rows[0] as Row)['version']);
    // One notification per deliverable channel; the .ics body travels with the e-mail, so it adds names but no channel.
    const channels = new Set<DeliveryChannel>();
    const declared = new Set<string>();
    for (const r of tpl.rows) {
      if (r['channel'] !== 'ics') channels.add(String(r['channel']) as DeliveryChannel);
      for (const v of r['variables'] as { name: string }[]) declared.add(v.name);
    }
    // Every declared name must be supplied, and nothing undeclared may be supplied.
    const extra = Object.keys(values).filter((k) => !declared.has(k));
    const missing = [...declared].filter((k) => !(k in values));
    if (extra.length > 0 || missing.length > 0)
      throw new NotificationsValidationError(['variables']);

    const result: SendResult = { created: [], duplicates: [] };
    const sendAfter = req.sendAfter ?? new Date();
    for (const channel of [...channels].sort()) {
      const id = uuidv7();
      // A plain INSERT inside a savepoint, not ON CONFLICT: PostgreSQL applies the SELECT policy to an ON CONFLICT insert, and
      // a booking transaction may insert a notification it is not allowed to read back (22.13: patients read in-app rows only).
      // A concurrent insert of the same key waits for the first to finish, then raises 23505 here: exactly one wins.
      await tx.query('SAVEPOINT notification_insert');
      try {
        await tx.query(
          `INSERT INTO notifications.notification
             (id, organisation_id, recipient_kind, patient_id, principal_id, template_key, template_version, channel, variables,
              status, attempts, send_after, dedupe_key, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued', 0, $10, $11, $12)`,
          [
            id,
            tx.scope.orgId,
            ref.kind,
            ref.kind === 'patient' ? ref.id : null,
            ref.kind === 'principal' ? ref.id : null,
            req.templateKey,
            version,
            channel,
            JSON.stringify(values),
            sendAfter,
            `${req.dedupeKey}:${channel}`,
            tx.scope.principalId ?? null,
          ],
        );
        await tx.query('RELEASE SAVEPOINT notification_insert');
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        await tx.query('ROLLBACK TO SAVEPOINT notification_insert');
        await tx.query('RELEASE SAVEPOINT notification_insert');
        result.duplicates.push(channel);
        continue;
      }
      result.created.push({ notificationId: id, channel });
      await this.d.queue.enqueue(
        tx,
        ref.kind === 'patient' ? 'notifications.send_message' : 'notifications.send_staff_message',
        ref.kind === 'patient' ? { notificationId: id, patientId: ref.id } : { notificationId: id },
        { runAt: sendAfter, jobKey: id },
      );
    }
    return result;
  }

  /**
   * Cancels queued or failed notifications whose dedupe key starts with `prefix` (e.g. `reminder:<reservation>`), in the
   * caller's transaction. Returns how many rows changed. A `sending` row is left alone (the send is under way); a `sent` row
   * is final. A scope that cannot see the rows cancels none: the count tells the caller.
   */
  async cancel(tx: Tx, prefix: string): Promise<number> {
    if (!PREFIX.test(prefix) || prefix.length > 150)
      throw new NotificationsValidationError(['prefix']);
    const r = await tx.query(
      `UPDATE notifications.notification SET status = 'cancelled'
        WHERE (dedupe_key = $1 OR starts_with(dedupe_key, $1 || ':')) AND status IN ('queued', 'failed')`,
      [prefix],
    );
    return r.rowCount ?? 0;
  }

  /** `GET /notices`: the patient's own in-app notices (T-PAT-OWN), newest first. Only IDs, template key and allowlisted values. */
  async listInApp(
    tx: Tx,
    limit = 50,
  ): Promise<
    { id: string; templateKey: string; variables: unknown; createdAt: Date; read: boolean }[]
  > {
    const n = Math.max(1, Math.min(100, Math.trunc(limit)));
    const r = await tx.query(
      `SELECT n.id, n.template_key, n.variables, n.created_at,
              EXISTS (SELECT 1 FROM notifications.in_app_read x WHERE x.notification_id = n.id) AS read
         FROM notifications.notification n
        WHERE n.channel = 'in_app' AND n.status = 'sent'
        ORDER BY n.created_at DESC, n.id DESC LIMIT $1`,
      [n],
    );
    return r.rows.map((x) => ({
      id: String(x['id']),
      templateKey: String(x['template_key']),
      variables: x['variables'],
      createdAt: x['created_at'] as Date,
      read: x['read'] === true,
    }));
  }

  /** `POST /notices/{id}/read`: idempotent; a second call changes nothing. Returns false when the notice is not the caller's. */
  async markRead(tx: Tx, notificationId: string): Promise<boolean> {
    const own = await tx.query(
      `SELECT patient_id FROM notifications.notification WHERE id = $1::uuid AND channel = 'in_app'`,
      [notificationId],
    );
    const patientId = own.rows[0]?.['patient_id'];
    if (typeof patientId !== 'string') return false;
    await tx.query(
      `INSERT INTO notifications.in_app_read (notification_id, organisation_id, patient_id, read_at, created_by)
       VALUES ($1::uuid, $2, $3::uuid, now(), $4) ON CONFLICT (notification_id) DO NOTHING`,
      [notificationId, tx.scope.orgId, patientId, tx.scope.principalId ?? null],
    );
    return true;
  }

  private async cleanValues(
    tx: Tx,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, string>> {
    const opts: ValueOptions =
      this.d.allowedLinkHosts === undefined ? {} : { allowedLinkHosts: this.d.allowedLinkHosts };
    const extra = (await this.d.forbiddenTerms?.(tx)) ?? [];
    const out: Record<string, string> = {};
    const bad: string[] = [];
    for (const [name, value] of Object.entries(raw)) {
      const type = Object.prototype.hasOwnProperty.call(VARIABLE_ALLOWLIST, name)
        ? VARIABLE_ALLOWLIST[name]
        : undefined;
      const v = type === undefined ? undefined : normaliseValue(type, value, opts);
      if (type === undefined || v === undefined) {
        bad.push(`variables.${/^[a-z][a-z0-9_]{0,40}$/.test(name) ? name : '*'}`);
        continue;
      }
      // Second line: a location name is the only free-ish text; refuse one that spells out a condition.
      if (type === 'location_name' && findForbidden(v, extra).length > 0) {
        bad.push(`variables.${name}`);
        continue;
      }
      out[name] = v;
    }
    if (bad.length > 0) throw new NotificationsValidationError(bad);
    return out;
  }
}
