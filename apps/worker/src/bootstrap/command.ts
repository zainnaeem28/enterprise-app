// The run-once `bootstrap-admins` command (INT04-F02b, decision log section 4). Not a queue job and never registered in the worker's job
// registry or crontab: it runs as a one-off task of the same release image under the dual-controlled `gh-bootstrap-<env>` path
// (DEVOPS-PLAN 16.2), takes no arguments and reads its inputs from the approved record only.
//
// Order: read and check the record, create both token secrets, call the database function once, delete the secrets of enrollees the
// function skipped, print the result. A plain token exists only in memory and in its own secret: never in a log line, an argument or an
// artifact (the output holds IDs, ARNs and the expiry). Any failure deletes both secrets and ends non-zero.
import { createHash, randomBytes } from 'node:crypto';
import {
  BootstrapRefusedError,
  REFUSAL_CODES,
  type ApprovedRecordPort,
  type BootstrapCallInput,
  type BootstrapDbPort,
  type BootstrapRecord,
  type RefusalCode,
  type SecretStorePort,
} from './ports.js';
import { InvalidRecordError, parseRecord } from './record.js';

/** How old the security-contact test may be (decision log section 4 step 1a). */
export const SECURITY_CONTACT_MAX_AGE_MS = 72 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV = /^[a-z][a-z0-9-]{0,30}$/;
const RUN_REF = /^[A-Za-z0-9._:-]{1,100}$/;

export interface BootstrapDeps {
  /** The environment name (`staging`, `production`): names the approved record and the secrets. */
  env: string;
  orgId: string;
  /** The CI run ID; becomes `bootstrap_run.run_ref` and the audit `job_id`. */
  runRef: string;
  /** The security-notice channel of the environment configuration the worker shares (absent: the worker's notice port refuses). */
  noticeChannel: string | undefined;
  record: ApprovedRecordPort;
  secrets: SecretStorePort;
  db: BootstrapDbPort;
  /** One line to stdout. Only IDs, ARNs, modes and times are ever passed; the unit test scans every line. */
  out: (line: string) => void;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
}

export type BootstrapExit =
  | { exitCode: 0 }
  | { exitCode: 1; reason: string; cleanupFailed: { slot: 1 | 2; secretArn: string | null }[] };

interface Slot {
  slot: 1 | 2;
  token: Buffer;
  arn: string | null;
  created: boolean;
}

const failCode = (e: unknown): string => {
  if (e instanceof BootstrapRefusedError) return `refused:${e.code}`;
  if (e instanceof InvalidRecordError) return `record:${e.field}`;
  return e instanceof Error && /^[A-Za-z]+Error$/.test(e.name) ? `error:${e.name}` : 'error';
};

export function refusalCodeOf(detail: unknown): RefusalCode {
  return typeof detail === 'string' && (REFUSAL_CODES as readonly string[]).includes(detail)
    ? (detail as RefusalCode)
    : 'error';
}

interface Entry {
  slot: 1 | 2;
  principalId: string;
  result: 'issued' | 'skipped';
  tokenId: string | null;
}
interface Outcome {
  mode: 'create' | 'reissue';
  runId: string;
  expiresAt: string;
  enrollees: [Entry, Entry];
}

/** Fail closed on anything that is not exactly two entries for slots 1 and 2 with a valid `result` (F02B-SEC-09 (a)). */
export function parseOutcome(raw: unknown): Outcome | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const list = o['enrollees'];
  if (
    (o['mode'] !== 'create' && o['mode'] !== 'reissue') ||
    typeof o['run_id'] !== 'string' ||
    !UUID.test(o['run_id']) ||
    typeof o['expires_at'] !== 'string' ||
    !Array.isArray(list) ||
    list.length !== 2
  )
    return undefined;
  const entries: Entry[] = [];
  for (let i = 0; i < 2; i++) {
    const e = list[i] as Record<string, unknown> | null;
    if (
      typeof e !== 'object' ||
      e === null ||
      e['slot'] !== i + 1 ||
      (e['result'] !== 'issued' && e['result'] !== 'skipped') ||
      typeof e['principal_id'] !== 'string' ||
      !UUID.test(e['principal_id'])
    )
      return undefined;
    entries.push({
      slot: (i + 1) as 1 | 2,
      principalId: e['principal_id'],
      result: e['result'],
      tokenId: typeof e['token_id'] === 'string' && UUID.test(e['token_id']) ? e['token_id'] : null,
    });
  }
  return {
    mode: o['mode'],
    runId: o['run_id'],
    expiresAt: o['expires_at'],
    enrollees: entries as [Entry, Entry],
  };
}

export async function runBootstrapAdmins(deps: BootstrapDeps): Promise<BootstrapExit> {
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? ((n: number): Buffer => randomBytes(n));
  const slots: Slot[] = [];
  const stop = async (reason: string): Promise<BootstrapExit> => {
    const cleanupFailed: { slot: 1 | 2; secretArn: string | null }[] = [];
    for (const s of slots) {
      s.token.fill(0);
      if (!s.created) continue;
      try {
        await deps.secrets.forceDeleteTokenSecret({ env: deps.env, slot: s.slot });
      } catch {
        cleanupFailed.push({ slot: s.slot, secretArn: s.arn });
      }
    }
    deps.out(JSON.stringify({ result: 'failed', reason, cleanupFailed }));
    return { exitCode: 1, reason, cleanupFailed };
  };

  // 1 and 1a: inputs and the security-contact precondition, before any secret or database call.
  if (!ENV.test(deps.env) || !UUID.test(deps.orgId) || !RUN_REF.test(deps.runRef))
    return stop('config');
  if (deps.noticeChannel === undefined || deps.noticeChannel.trim() === '')
    return stop('precondition:notice_channel');
  let record: BootstrapRecord;
  try {
    record = parseRecord(await deps.record.read(deps.env));
  } catch (e) {
    return stop(failCode(e));
  }
  const verifiedAt =
    record.securityContactVerifiedAt === undefined
      ? Number.NaN
      : Date.parse(record.securityContactVerifiedAt);
  const age = now().getTime() - verifiedAt;
  if (
    record.securityContactTestRef === undefined ||
    Number.isNaN(age) ||
    age < 0 ||
    age > SECURITY_CONTACT_MAX_AGE_MS
  )
    return stop('precondition:security_contact');

  // 2: two tokens, in memory. The hash is of the UTF-8 bytes of the 43-character string, the value `hashPresentedToken` derives at enrolment.
  for (const slot of [1, 2] as const) {
    const raw = random(32);
    const token = Buffer.from(raw.toString('base64url'), 'utf8');
    raw.fill(0);
    slots.push({ slot, token, arn: null, created: false });
  }
  const hashes = slots.map((s) => createHash('sha256').update(s.token).digest());

  // 3: the secrets exist before the database call. A failure here stops with nothing in the database.
  for (const s of slots) {
    try {
      const made = await deps.secrets.createTokenSecret({
        env: deps.env,
        slot: s.slot,
        runRef: deps.runRef,
        value: Buffer.from(s.token),
      });
      s.arn = made.arn;
      s.created = true;
    } catch (e) {
      // The create may have succeeded before the error was raised: the clean-up tries this slot too.
      s.created = true;
      return stop(`secret:${failCode(e)}`);
    }
  }

  // 4: the one database call.
  const input: BootstrapCallInput = {
    orgId: deps.orgId,
    runRef: deps.runRef,
    ticketRef: record.ticketRef,
    enrollees: record.enrollees.map((e) => ({ handle: e.handle, display_name: e.displayName })),
    custodians: record.custodians.map((c) =>
      c.enrollee === undefined
        ? { idp_id: c.idpId, display_name: c.displayName }
        : { idp_id: c.idpId, enrollee: c.enrollee },
    ),
    tokenHashes: hashes,
  };
  let raw: unknown;
  try {
    raw = await deps.db.call(input);
  } catch (e) {
    return stop(`database:${failCode(e)}`);
  }
  const outcome = parseOutcome(raw);
  if (outcome === undefined) {
    // The transaction committed: the issued tokens expire unread after 30 minutes and recovery is a reissue run.
    return stop('database:malformed_result');
  }

  // 4a: the secret of a skipped enrollee holds a token whose hash was never stored; it goes now, before any output.
  const cleanupFailed: { slot: 1 | 2; secretArn: string | null }[] = [];
  for (const e of outcome.enrollees) {
    if (e.result !== 'skipped') continue;
    const s = slots[e.slot - 1] as Slot;
    s.token.fill(0);
    try {
      await deps.secrets.forceDeleteTokenSecret({ env: deps.env, slot: e.slot });
      s.created = false;
    } catch {
      cleanupFailed.push({ slot: e.slot, secretArn: s.arn });
    }
  }
  if (cleanupFailed.length > 0) {
    // Name the slot as skipped: the runbook deletes it with the break-glass role before any custodian is told to read.
    for (const s of slots) s.token.fill(0);
    deps.out(
      JSON.stringify({
        result: 'failed',
        reason: 'skipped_secret_not_deleted',
        skipped: cleanupFailed,
      }),
    );
    return { exitCode: 1, reason: 'skipped_secret_not_deleted', cleanupFailed };
  }

  // 5: overwrite the buffers, then the result: IDs, ARNs and the expiry only.
  for (const s of slots) s.token.fill(0);
  deps.out(
    JSON.stringify({
      result: 'ok',
      mode: outcome.mode,
      runId: outcome.runId,
      expiresAt: outcome.expiresAt,
      enrollees: outcome.enrollees.map((e) =>
        e.result === 'issued'
          ? {
              slot: e.slot,
              principalId: e.principalId,
              result: 'issued',
              tokenId: e.tokenId,
              secretArn: (slots[e.slot - 1] as Slot).arn,
            }
          : { slot: e.slot, principalId: e.principalId, result: 'skipped', secret: 'deleted' },
      ),
    }),
  );
  return { exitCode: 0 };
}
