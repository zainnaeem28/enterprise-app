// Proxy rules, worker side (owner ruling 2026-11-11 C item 3, D-7, RA-R1-20b): `identity.send_proxy_invite` and `identity.proxy_age_out`.
//
//   send_proxy_invite  Makes the e-mail code of an invitation, stores only its salted hash (identity.proxy_invite_code), and mails the
//                      code to the invited address. The code exists in clear in this function and in the mail, nowhere else. A retry makes
//                      a new code and replaces the hash, so the last mail is the one that works. The database commits before the mail
//                      goes out: a mail that cannot be sent leaves a code nobody holds (the job retries), never a mailed code that does not work.
//   proxy_age_out      Daily. (1) re-derives the dates of open guardian grants from the stored birth date and the CURRENT settings, so a
//                      settings change is applied by the next run; (2) ends guardian grants whose last day has passed (status `expired`,
//                      reason `age_out`); (3) ends invitations nobody accepted in time; (4) mails the notice `proxy_age_out_notice_days` before
//                      access ends, once per grant. Each step has its own transaction, so a mail provider that is down stops step 4 only;
//                      the expiry has already happened. Access itself never waits for this job: the scope builder and the row-level security
//                      compute it from valid_until and the age dates on every request.
// Every change writes an audit event as the job (realm `worker`, audience `system`), in the same transaction as the change.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { KernelDb, Tx } from '@ehr/kernel';
import { isUuid, systemScope } from './scope.js';

/** Sends the two mails of the proxy rules. The provider (C-10) is not chosen; the composition root injects it, and until then it refuses. */
export interface ProxyMailPort {
  /** The e-mail code of an invitation. `to` is the invited address; nothing about the patient is in the mail. */
  sendInviteCode(m: {
    to: string;
    code: string;
    grantId: string;
    expiresAt: Date;
    jobRef: string;
  }): Promise<void>;
  /** The notice before a guardian's access ends. `endsOn` is the first day without access (the birthday), `YYYY-MM-DD`. */
  sendAgeOutNotice(m: {
    to: string;
    grantId: string;
    endsOn: string;
    daysLeft: number;
    jobRef: string;
  }): Promise<void>;
}

export interface ProxyRulesDeps {
  db: KernelDb;
  orgId: string;
  mail: ProxyMailPort;
}

const SETTINGS = [
  'proxy_age_of_majority',
  'proxy_adolescent_min_age',
  'proxy_age_out_notice_days',
  'proxy_invite_hours',
  'proxy_code_max_attempts',
] as const;
type SettingKey = (typeof SETTINGS)[number];

async function intSetting(tx: Tx, key: SettingKey): Promise<number> {
  const r = await tx.query(`SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`, [key]);
  const v = r.rows[0]?.['value'];
  // A missing rule value fails closed: the job errors (and retries, then dead-letters) rather than guessing an age.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new Error(`proxy rules: setting ${key} is not configured`);
  return v;
}

/** SHA-256(salt || code): the same function the API verifies with (apps/api identity/proxy.ts `hashInviteCode`). */
export const hashInviteCode = (salt: Buffer, code: string): Buffer =>
  createHash('sha256').update(salt).update(code, 'utf8').digest();

/** A deterministic UUID per (purpose, key): a retry finds its own audit event. */
function eventId(purpose: string, key: string): string {
  const h = createHash('sha256').update(`identity:${purpose}:${key}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const AUDIT = `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
  SELECT $1::uuid, $2::uuid, $3, 'worker', 'system', 'update', 'identity.proxy_grant', $4::uuid, $5::uuid, $6::jsonb, 'allowed'
   WHERE NOT EXISTS (SELECT 1 FROM audit.event e WHERE e.event_id = $1::uuid)`;

async function audit(
  tx: Tx,
  orgId: string,
  jobRef: string,
  purpose: string,
  grantId: string,
  patientId: string,
  change: Record<string, unknown>,
): Promise<void> {
  await tx.query(AUDIT, [
    eventId(purpose, grantId),
    orgId,
    jobRef.slice(0, 200),
    grantId,
    patientId,
    JSON.stringify(change),
  ]);
}

export interface SendInviteResult {
  outcome: 'sent' | 'skipped';
}

export async function runSendProxyInvite(
  deps: ProxyRulesDeps,
  payload: Record<string, unknown>,
  jobRef = 'identity.send_proxy_invite',
): Promise<SendInviteResult> {
  const grantId = payload['grantId'];
  if (!isUuid(grantId)) throw new Error('identity.send_proxy_invite: grantId is required');
  const prepared = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const g = (
      await tx.query(
        `SELECT patient_id, invited_email FROM identity.proxy_grant
          WHERE id = $1 AND proxy_principal_id IS NULL AND status IN ('requested', 'verified') FOR UPDATE`,
        [grantId],
      )
    ).rows[0];
    // Withdrawn, accepted or expired before the mail went out: nothing to send.
    if (g === undefined || typeof g['invited_email'] !== 'string') return undefined;
    const hours = await intSetting(tx, 'proxy_invite_hours');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16);
    const hash = hashInviteCode(salt, code);
    const row = (
      await tx.query(
        `INSERT INTO identity.proxy_invite_code (grant_id, organisation_id, salt, code_hash, expires_at, sent_at, created_by_job)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int), now(), NULL)
         ON CONFLICT (grant_id) DO UPDATE
           SET salt = EXCLUDED.salt, code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, sent_at = now()
         RETURNING expires_at`,
        [grantId, deps.orgId, salt, hash, hours],
      )
    ).rows[0];
    await tx.query(AUDIT, [
      eventId(`proxy_invite_sent:${randomBytes(8).toString('hex')}`, grantId),
      deps.orgId,
      jobRef.slice(0, 200),
      grantId,
      g['patient_id'],
      JSON.stringify({ event: 'proxy_invite_sent' }),
    ]);
    return { to: g['invited_email'], code, expiresAt: row?.['expires_at'] as Date };
  });
  if (prepared === undefined) return { outcome: 'skipped' };
  await deps.mail.sendInviteCode({ ...prepared, grantId, jobRef });
  return { outcome: 'sent' };
}

export interface AgeOutResult {
  rederived: number;
  expired: number;
  invitesExpired: number;
  noticed: number;
}

export async function runProxyAgeOut(
  deps: ProxyRulesDeps,
  jobRef = 'identity.proxy_age_out',
): Promise<AgeOutResult> {
  const scope = systemScope(deps.orgId);
  const result: AgeOutResult = { rederived: 0, expired: 0, invitesExpired: 0, noticed: 0 };

  // 1. dates follow the settings -------------------------------------------------------------------------------------------------
  result.rederived = await deps.db.withScope(scope, async (tx) => {
    const majority = await intSetting(tx, 'proxy_age_of_majority');
    const adolescent = await intSetting(tx, 'proxy_adolescent_min_age');
    const r = await tx.query(
      `UPDATE identity.proxy_grant g
          SET adolescent_from = (g.patient_birth_date + make_interval(years => $1::int))::date,
              valid_until     = (g.patient_birth_date + make_interval(years => $2::int))::date - 1,
              age_out_notice_at = CASE WHEN g.valid_until IS DISTINCT FROM ((g.patient_birth_date + make_interval(years => $2::int))::date - 1)
                                       THEN NULL ELSE g.age_out_notice_at END
        WHERE g.guardian AND g.patient_birth_date IS NOT NULL AND g.status IN ('requested', 'verified', 'active')
          AND (g.adolescent_from IS DISTINCT FROM (g.patient_birth_date + make_interval(years => $1::int))::date
               OR g.valid_until IS DISTINCT FROM (g.patient_birth_date + make_interval(years => $2::int))::date - 1)`,
      [adolescent, majority],
    );
    return r.rowCount ?? 0;
  });

  // 2. access ends -----------------------------------------------------------------------------------------------------------------
  result.expired = await deps.db.withScope(scope, async (tx) => {
    const due = (
      await tx.query(
        `SELECT id, patient_id, valid_until FROM identity.proxy_grant
          WHERE guardian AND status IN ('requested', 'verified', 'active') AND valid_until < current_date ORDER BY id FOR UPDATE`,
      )
    ).rows;
    for (const g of due) {
      await tx.query(
        `UPDATE identity.proxy_grant SET status = 'expired', revoke_reason = 'age_out', ended_by = 'age_out' WHERE id = $1`,
        [g['id']],
      );
      await audit(tx, deps.orgId, jobRef, 'proxy_age_out', g['id'] as string, g['patient_id'] as string, {
        event: 'proxy_aged_out',
        validUntil: String(g['valid_until']).slice(0, 10),
      });
    }
    return due.length;
  });

  // 3. invitations nobody accepted -------------------------------------------------------------------------------------------------
  result.invitesExpired = await deps.db.withScope(scope, async (tx) => {
    const hours = await intSetting(tx, 'proxy_invite_hours');
    const stale = (
      await tx.query(
        `SELECT g.id, g.patient_id FROM identity.proxy_grant g
           LEFT JOIN identity.proxy_invite_code c ON c.grant_id = g.id
          WHERE g.proxy_principal_id IS NULL AND g.status IN ('requested', 'verified')
            AND (c.expires_at < now() OR (c.grant_id IS NULL AND g.created_at < now() - make_interval(hours => $1::int)))
          ORDER BY g.id FOR UPDATE OF g`,
        [hours],
      )
    ).rows;
    for (const g of stale) {
      await tx.query(
        `UPDATE identity.proxy_grant SET status = 'expired', revoke_reason = 'age_out', ended_by = 'invite_expired' WHERE id = $1`,
        [g['id']],
      );
      await audit(tx, deps.orgId, jobRef, 'proxy_invite_expired', g['id'] as string, g['patient_id'] as string, {
        event: 'proxy_invite_expired',
      });
    }
    return stale.length;
  });

  // 4. notice ----------------------------------------------------------------------------------------------------------------------
  const failures: unknown[] = [];
  const toNotify = await deps.db.withScope(scope, async (tx) => {
    const days = await intSetting(tx, 'proxy_age_out_notice_days');
    const rows = (
      await tx.query(
        `SELECT g.id, g.patient_id, p.email, (g.valid_until + 1) AS ends_on, ((g.valid_until + 1) - current_date) AS days_left
           FROM identity.proxy_grant g JOIN identity.principal p ON p.id = g.proxy_principal_id
          WHERE g.guardian AND g.status = 'active' AND g.age_out_notice_at IS NULL AND g.valid_until >= current_date
            AND current_date >= (g.valid_until + 1) - $1::int AND p.email IS NOT NULL
          ORDER BY g.id`,
        [days],
      )
    ).rows;
    return rows;
  });
  for (const g of toNotify) {
    try {
      await deps.mail.sendAgeOutNotice({
        to: g['email'] as string,
        grantId: g['id'] as string,
        endsOn: String(g['ends_on'] instanceof Date ? g['ends_on'].toISOString() : g['ends_on']).slice(0, 10),
        daysLeft: Number(g['days_left']),
        jobRef,
      });
      await deps.db.withScope(scope, async (tx) => {
        await tx.query(`UPDATE identity.proxy_grant SET age_out_notice_at = now() WHERE id = $1 AND age_out_notice_at IS NULL`, [g['id']]);
        await audit(tx, deps.orgId, jobRef, 'proxy_age_out_notice', g['id'] as string, g['patient_id'] as string, {
          event: 'proxy_age_out_notice_sent',
          daysLeft: Number(g['days_left']),
        });
      });
      result.noticed += 1;
    } catch (e) {
      failures.push(e);
    }
  }
  // Everything that could be done is done; a failed notice makes the job fail so it retries (the notice is sent once, then marked).
  if (failures.length > 0)
    throw new Error(`identity.proxy_age_out: ${failures.length} notice(s) not sent (${result.expired} expired, ${result.noticed} noticed)`);
  return result;
}
