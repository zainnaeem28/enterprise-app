// `notifications.send_message` / `notifications.send_staff_message` (ARCHITECTURE 33.1, SHARED-BOUNDARIES 3.2 rule 7).
// Steps, each its own short transaction (the vendor call never holds a database transaction open):
//   1. claim:   read the row under the job's scope. Terminal (sent, suppressed, cancelled) -> end WITHOUT writing (22.16 "jobs in
//               flight"). Not yet due -> try later. Otherwise `sending`, attempts + 1. A job that names a MERGED patient finds no row
//               under that scope; it asks for the survivor and runs again under the survivor's scope (`on_merged = resolve`).
//   2. resolve: ask the contributor for the person's permitted channels, address, language and quiet hours (preferences already
//               applied). Nothing about the address is stored. No recipient / no address / preference off -> `suppressed`
//               with that reason; quiet hours -> re-queued for when they end.
//   3. render:  the published version bound to the row, in the person's language (fallback: the default language); the final
//               PHI scan runs on the OUTPUT too (a second line behind the allowlist and the render check).
//   4. send:    `callVendor(kind, 'send', ...)` with a token derived from the notification ID, so a retry after a crash cannot
//               send twice at a vendor that honours it. In-app notices need no vendor.
//   5. record:  `sent` (provider reference), or `failed` with an error CLASS. A vendor refusal is final; an unavailable vendor
//               fails the job so the queue retries with back-off (8 attempts); the last attempt publishes
//               `notifications.delivery_failed` (operations view, BR-33).
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import { VendorRejectedError, VendorUnavailableError } from '../integration-core/index.js';
import type { VendorGateway } from '../integration-core/index.js';
import { findForbidden } from './forbidden.js';
import { isUuid } from './ids.js';
import {
  quietHoursEnd,
  type DeliveryChannel,
  type RecipientContributors,
  type ResolvedRecipient,
  type WithheldReason,
} from './recipient.js';
import { RenderError, renderTemplate, type Channel } from './render.js';
import { patientsScope, systemScope } from './scope.js';

export interface SendDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  gateway: VendorGateway;
  recipients: RecipientContributors;
  log: Logger;
  defaultLanguage?: string;
  /** `patient`'s answer to "who is the survivor of this ID" (closure). Without it a merged ID is never followed. */
  survivorOf?: (patientId: string) => Promise<string | undefined>;
  /** Deployment terms for the final scan (same source as the API). */
  forbiddenTerms?: (tx: Tx) => Promise<readonly string[]>;
  now?: () => Date;
}

export interface Attempt {
  /** 1-based attempt number of this run and the job's maximum (`helpers.job`). */
  number: number;
  max: number;
}

export type SendOutcome = 'sent' | 'suppressed' | 'deferred' | 'failed' | 'already_final' | 'gone';

type Row = Record<string, unknown>;
const TERMINAL = new Set(['sent', 'suppressed', 'cancelled']);

interface Claimed {
  kind: 'claim';
  row: Row;
}

export async function runSendMessage(
  deps: SendDeps,
  payload: Record<string, unknown>,
  attempt: Attempt,
): Promise<SendOutcome> {
  const notificationId = payload['notificationId'];
  const patientId = payload['patientId'];
  if (!isUuid(notificationId) || (patientId !== undefined && !isUuid(patientId)))
    throw new Error('notifications.send_message: bad payload');
  const now = deps.now ?? (() => new Date());

  let scopeIds: string | undefined = patientId as string | undefined;
  let claim = await claimRow(deps, notificationId, scopeIds, now());
  if (claim === 'gone' && scopeIds !== undefined && deps.survivorOf !== undefined) {
    const survivor = await deps.survivorOf(scopeIds);
    if (survivor !== undefined && survivor.toLowerCase() !== scopeIds.toLowerCase()) {
      scopeIds = survivor.toLowerCase();
      claim = await claimRow(deps, notificationId, scopeIds, now());
    }
  }
  if (claim === 'gone') return 'gone';
  if (claim === 'final') return 'already_final';
  if (claim.kind === 'later') {
    await deps.db.withScope(scopeFor(deps, scopeIds), (tx) =>
      deps.queue.enqueue(tx, queueName(scopeIds), jobPayload(notificationId, scopeIds), {
        runAt: claim.at,
        jobKey: notificationId,
      }),
    );
    return 'deferred';
  }
  const row = claim.row;
  const scope = scopeFor(deps, scopeIds);
  const channel = String(row['channel']) as DeliveryChannel;

  // 2. resolve
  const decision = await deps.db.withScope(scope, async (tx) => {
    const kind = String(row['recipient_kind']) as 'patient' | 'principal';
    const id = String(kind === 'patient' ? row['patient_id'] : row['principal_id']);
    const contributor = kind === 'patient' ? deps.recipients.patient : deps.recipients.principal;
    const who = contributor === undefined ? undefined : await contributor.resolve(tx, id);
    return decide(channel, who);
  });

  if (decision.kind === 'suppress') {
    await finish(deps, scope, notificationId, {
      status: 'suppressed',
      suppress_reason: decision.reason,
    });
    return 'suppressed';
  }
  if (channel === 'in_app') {
    await finish(deps, scope, notificationId, {
      status: 'sent',
      language: decision.language,
      sent_at: now(),
    });
    return 'sent';
  }
  if (decision.quietHours !== undefined) {
    const end = quietHoursEnd(decision.quietHours, now());
    if (end !== undefined) {
      await deps.db.withScope(scope, async (tx) => {
        await tx.query(
          `UPDATE notifications.notification SET status = 'queued', send_after = $2, attempts = attempts - 1 WHERE id = $1::uuid`,
          [notificationId, end],
        );
        await deps.queue.enqueue(tx, queueName(scopeIds), jobPayload(notificationId, scopeIds), {
          runAt: end,
          jobKey: notificationId,
        });
      });
      return 'deferred';
    }
  }

  // 3. render
  const rendered = await deps.db.withScope(scope, async (tx) => {
    const lang = decision.language;
    const fallback = deps.defaultLanguage ?? 'en';
    const find = async (ch: string): Promise<Row | undefined> =>
      (
        await tx.query(
          `SELECT subject, body, variables, language FROM notifications.template
            WHERE key = $1 AND version = $2 AND channel = $3 AND language IN ($4, $5) AND status IN ('published', 'retired')
            ORDER BY (language = $4) DESC LIMIT 1`,
          [row['template_key'], row['template_version'], ch, lang, fallback],
        )
      ).rows[0];
    const main = await find(channel);
    const ics = channel === 'email' ? await find('ics') : undefined;
    const extra = (await deps.forbiddenTerms?.(tx)) ?? [];
    return { main, ics, extra };
  });
  if (rendered.main === undefined) {
    await finish(deps, scope, notificationId, {
      status: 'suppressed',
      suppress_reason: 'no_template',
    });
    return 'suppressed';
  }
  const values = row['variables'] as Record<string, string>;
  let out: { subject: string | null; body: string };
  let icsBody: string | undefined;
  try {
    const m = rendered.main;
    out = renderTemplate(
      {
        channel: channel as Channel,
        language: String(m['language']),
        subject: (m['subject'] as string | null) ?? null,
        body: String(m['body']),
        declared: (m['variables'] as { name: string }[]).map((v) => v.name),
      },
      values,
    );
    if (rendered.ics !== undefined) {
      const i = rendered.ics;
      icsBody = renderTemplate(
        {
          channel: 'ics',
          language: String(i['language']),
          subject: null,
          body: String(i['body']),
          declared: (i['variables'] as { name: string }[]).map((v) => v.name),
        },
        values,
      ).body;
    }
  } catch (e) {
    return fail(
      deps,
      scope,
      notificationId,
      e instanceof RenderError ? `render_${e.rule}` : 'render_failed',
      attempt,
      true,
    );
  }
  const scanned = `${out.subject ?? ''}\n${out.body}\n${icsBody ?? ''}`;
  if (findForbidden(scanned, rendered.extra).length > 0)
    return fail(deps, scope, notificationId, 'phi_guard', attempt, true);

  // 4. send (no database transaction is open)
  const address = decision.address;
  if (address === undefined) {
    await finish(deps, scope, notificationId, {
      status: 'suppressed',
      suppress_reason: 'no_address',
    });
    return 'suppressed';
  }
  const args: Record<string, unknown> =
    channel === 'email'
      ? {
          to: address,
          subject: out.subject,
          text: out.body,
          ...(icsBody === undefined
            ? {}
            : {
                attachments: [
                  {
                    filename: 'appointment.ics',
                    contentType: 'text/calendar; method=PUBLISH',
                    content: icsBody,
                  },
                ],
              }),
        }
      : channel === 'sms'
        ? { to: address, text: out.body }
        : {
            to: address,
            text: out.body,
            ...(out.subject === null ? {} : { subject: out.subject }),
          };
  try {
    const r = await deps.gateway.callVendor(channel, 'send', args, {
      type: 'notification',
      id: notificationId,
      idempotencyToken: `n-${notificationId}`,
    });
    await finish(deps, scope, notificationId, {
      status: 'sent',
      sent_at: now(),
      language: decision.language,
      provider_message_id: r.vendorRef ?? null,
      error_class: null,
    });
    return 'sent';
  } catch (err) {
    if (err instanceof VendorRejectedError)
      return fail(deps, scope, notificationId, 'vendor_rejected', attempt, true);
    if (err instanceof VendorUnavailableError) {
      await fail(deps, scope, notificationId, `vendor_${err.reason}`, attempt, false);
      throw err; // the queue retries with back-off; the last attempt has published delivery_failed
    }
    throw err;
  }
}

type Decision =
  | {
      kind: 'suppress';
      reason: 'no_recipient' | 'patient_inactive' | 'not_permitted' | WithheldReason;
    }
  | {
      kind: 'go';
      language: string;
      address: string | undefined;
      quietHours: ResolvedRecipient['quietHours'];
    };

function decide(channel: DeliveryChannel, who: ResolvedRecipient | undefined): Decision {
  if (who === undefined) return { kind: 'suppress', reason: 'no_recipient' };
  if (!who.active) return { kind: 'suppress', reason: 'patient_inactive' };
  const target = who.permitted.find((p) => p.channel === channel);
  if (target === undefined) {
    const w = who.withheld.find((x) => x.channel === channel);
    return { kind: 'suppress', reason: w?.reason ?? 'not_permitted' };
  }
  return {
    kind: 'go',
    language: who.language,
    address: target.address,
    quietHours: who.quietHours,
  };
}

async function claimRow(
  deps: SendDeps,
  id: string,
  patientId: string | undefined,
  at: Date,
): Promise<Claimed | { kind: 'later'; at: Date } | 'gone' | 'final'> {
  return deps.db.withScope(scopeFor(deps, patientId), async (tx) => {
    const r = await tx.query(
      `SELECT * FROM notifications.notification WHERE id = $1::uuid FOR UPDATE`,
      [id],
    );
    const row = r.rows[0];
    if (row === undefined) return 'gone';
    if (TERMINAL.has(String(row['status']))) return 'final';
    const due = row['send_after'] as Date;
    if (due.getTime() > at.getTime()) return { kind: 'later', at: due } as const;
    await tx.query(
      `UPDATE notifications.notification SET status = 'sending', attempts = attempts + 1 WHERE id = $1::uuid`,
      [id],
    );
    return { kind: 'claim', row } as const;
  });
}

type Patch = Partial<{
  status: 'sent' | 'suppressed' | 'failed';
  suppress_reason: string;
  error_class: string | null;
  provider_message_id: string | null;
  sent_at: Date;
  language: string;
}>;

async function finish(
  deps: SendDeps,
  scope: ReturnType<typeof scopeFor>,
  id: string,
  p: Patch,
): Promise<void> {
  const cols = Object.keys(p);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await deps.db.withScope(scope, async (tx) => {
    await tx.query(`UPDATE notifications.notification SET ${sets} WHERE id = $1::uuid`, [
      id,
      ...cols.map((c) => (p as Row)[c]),
    ]);
  });
}

async function fail(
  deps: SendDeps,
  scope: ReturnType<typeof scopeFor>,
  id: string,
  errorClass: string,
  attempt: Attempt,
  final: boolean,
): Promise<'failed'> {
  await deps.db.withScope(scope, async (tx) => {
    await tx.query(
      `UPDATE notifications.notification SET status = 'failed', error_class = $2 WHERE id = $1::uuid`,
      [id, errorClass.slice(0, 60)],
    );
    if (final || attempt.number >= attempt.max)
      await deps.queue.publish(tx, 'notifications.delivery_failed', { notificationId: id });
  });
  deps.log.warn('notification failed', { notificationId: id, errorClass });
  return 'failed';
}

function scopeFor(deps: SendDeps, patientId: string | undefined): ReturnType<typeof systemScope> {
  return patientId === undefined ? systemScope(deps.orgId) : patientsScope(deps.orgId, [patientId]);
}
const queueName = (patientId: string | undefined): string =>
  patientId === undefined ? 'notifications.send_staff_message' : 'notifications.send_message';
const jobPayload = (id: string, patientId: string | undefined): Record<string, unknown> =>
  patientId === undefined ? { notificationId: id } : { notificationId: id, patientId };
