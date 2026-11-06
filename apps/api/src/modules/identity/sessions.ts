// Server-side sessions (ARCHITECTURE 26.2, ADR-021). The cookie holds a 256-bit token; the database holds only its
// SHA-256. There is NO in-process session cache: every request does one indexed lookup, so a revocation takes effect on
// the next request. Idle expiry moves only on interactive requests (at most once a minute); passive requests (the closed
// list in `PASSIVE_ROUTES`) never extend it (TDR-06).
import type { KernelDb, Tx } from '@ehr/kernel';
import { UnauthenticatedError } from './errors.js';
import { AUDIENCE_OF } from './types.js';
import type { PrincipalRealm, SessionAudience, SessionRow } from './types.js';

export type RevokeReason =
  'sign_out' | 'kill_switch' | 'role_change' | 'idle' | 'absolute' | 'realm_switch';

/** Defaults are the PRD 7.2 / 26.2 values; the stored `kernel.setting` rows (pre_auth keys) win when present and valid. */
const IDLE_KEY: Readonly<Record<PrincipalRealm, string>> = {
  google: 'staff_idle_minutes',
  admin_pool: 'admin_idle_minutes',
  patient_pool: 'patient_idle_minutes',
  partner_pool: 'patient_idle_minutes',
};
const IDLE_DEFAULT_MIN: Readonly<Record<PrincipalRealm, number>> = {
  google: 15,
  admin_pool: 10,
  patient_pool: 30,
  partner_pool: 30,
};
/** Absolute lifetimes (26.2 table): 12 h, 8 h for admins, 12 h. */
const ABSOLUTE_HOURS: Readonly<Record<PrincipalRealm, number>> = {
  google: 12,
  admin_pool: 8,
  patient_pool: 12,
  partner_pool: 12,
};
/** Idle/last-seen writes happen at most once a minute per session (26.2). */
export const TOUCH_INTERVAL_MS = 60_000;

/**
 * The passive list of 26.2: closed and fixed. Matched on the request method and path template, never on a header.
 * Everything else is interactive.
 */
export const PASSIVE_ROUTES: readonly { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/api\/v1\/alerts\/stream\/?$/ },
  { method: 'GET', pattern: /^\/api\/v1\/alerts\/open-ids\/?$/ },
  { method: 'GET', pattern: /^\/api\/v1\/appointments\/[^/]+\/video-session\/?$/ },
];

export function isPassive(method: string, path: string): boolean {
  return PASSIVE_ROUTES.some((r) => r.method === method.toUpperCase() && r.pattern.test(path));
}

export interface SessionLifetimes {
  idleMs: number;
  absoluteMs: number;
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const toDateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : toDate(v);

export function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r['id'] as string,
    principalId: r['principal_id'] as string,
    personId: r['person_id'] as string,
    realm: r['realm'] as PrincipalRealm,
    audience: r['audience'] as SessionAudience,
    authTime: toDate(r['auth_time']),
    csrfHash: r['csrf_hash'] as Buffer,
    idleExpiresAt: toDate(r['idle_expires_at']),
    absoluteExpiresAt: toDate(r['absolute_expires_at']),
    lastInteractionAt: toDateOrNull(r['last_interaction_at']),
    revokedAt: toDateOrNull(r['revoked_at']),
  };
}

export const SESSION_COLUMNS =
  'id, principal_id, person_id, realm, audience, auth_time, csrf_hash, idle_expires_at, absolute_expires_at, last_interaction_at, revoked_at';

export async function lifetimesFor(tx: Tx, realm: PrincipalRealm): Promise<SessionLifetimes> {
  const key = IDLE_KEY[realm];
  const { rows } = await tx.query(
    `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`,
    [key],
  );
  const v = rows[0]?.['value'];
  const idleMin =
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1440
      ? v
      : IDLE_DEFAULT_MIN[realm];
  return { idleMs: idleMin * 60_000, absoluteMs: ABSOLUTE_HOURS[realm] * 3_600_000 };
}

export type Lookup =
  | { state: 'none' }
  | { state: 'live'; session: SessionRow }
  | { state: 'expired'; session: SessionRow; reason: 'idle' | 'absolute' }
  | { state: 'revoked'; session: SessionRow };

export class SessionService {
  constructor(private readonly deps: { db: KernelDb; orgId: string; now?: () => Date }) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** The one lookup per request (21.3 list item 1): audience `anonymous`, by the hash of the presented cookie. */
  async lookup(tokenHashHex: string): Promise<Lookup> {
    const row = await this.deps.db.withScope(
      { audience: 'anonymous', orgId: this.deps.orgId, sessionTokenHash: tokenHashHex },
      async (tx) =>
        (
          await tx.query(
            `SELECT ${SESSION_COLUMNS} FROM identity.session WHERE token_hash = decode($1, 'hex') LIMIT 1`,
            [tokenHashHex],
          )
        ).rows[0],
      { idempotent: true },
    );
    if (row === undefined) return { state: 'none' };
    const session = rowToSession(row);
    if (session.revokedAt !== null) return { state: 'revoked', session };
    const t = this.now().getTime();
    if (t >= session.absoluteExpiresAt.getTime())
      return { state: 'expired', session, reason: 'absolute' };
    if (t >= session.idleExpiresAt.getTime()) return { state: 'expired', session, reason: 'idle' };
    return { state: 'live', session };
  }

  /** The scope of the session's own principal: what T-PRINCIPAL policies match. */
  scopeOf(s: SessionRow) {
    return {
      audience: s.audience,
      realm: s.realm,
      orgId: this.deps.orgId,
      principalId: s.principalId,
      personId: s.personId,
    } as const;
  }

  /** Records the idle/absolute expiry the lookup found (`idle`/`absolute`), under the session's own settings. */
  async revokeExpired(s: SessionRow, reason: 'idle' | 'absolute'): Promise<void> {
    await this.revoke(s, reason);
  }

  async revoke(s: SessionRow, reason: RevokeReason): Promise<boolean> {
    return this.deps.db.withScope(this.scopeOf(s), async (tx) => {
      const r = await tx.query(
        `UPDATE identity.session SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL`,
        [s.id, this.now(), reason],
      );
      return (r.rowCount ?? 0) === 1;
    });
  }

  /**
   * Interactive touch (26.2): writes `last_seen_at`, `last_interaction_at` and `idle_expires_at` at most once a minute,
   * never past `absolute_expires_at`, never on a revoked or expired row. `force` skips the once-a-minute limit (the
   * explicit "Stay signed in?" action). Returns the idle expiry now in force.
   */
  async touch(tx: Tx, s: SessionRow, opts: { force?: boolean } = {}): Promise<Date> {
    const now = this.now();
    const { idleMs } = await lifetimesFor(tx, s.realm);
    const r = await tx.query(
      `UPDATE identity.session
          SET last_seen_at = $2, last_interaction_at = $2,
              idle_expires_at = LEAST($2::timestamptz + make_interval(secs => $3), absolute_expires_at)
        WHERE id = $1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2
          AND ($4 OR last_interaction_at IS NULL OR last_interaction_at <= $2::timestamptz - make_interval(secs => $5))
        RETURNING idle_expires_at`,
      [s.id, now, idleMs / 1000, opts.force === true, TOUCH_INTERVAL_MS / 1000],
    );
    const row = r.rows[0];
    if (row !== undefined) return toDate(row['idle_expires_at']);
    // Not touched (within the minute, or the row just ended): report what is stored.
    const cur = await tx.query(
      `SELECT idle_expires_at, revoked_at FROM identity.session WHERE id = $1`,
      [s.id],
    );
    const c = cur.rows[0];
    if (c === undefined || c['revoked_at'] !== null) throw new UnauthenticatedError();
    const idle = toDate(c['idle_expires_at']);
    if (idle.getTime() <= now.getTime()) throw new UnauthenticatedError('auth.session_expired');
    return idle;
  }

  /** `POST /auth/session/extend`: interactive and explicit, so it ignores the once-a-minute limit. */
  async extend(s: SessionRow): Promise<Date> {
    return this.deps.db.withScope(this.scopeOf(s), (tx) => this.touch(tx, s, { force: true }));
  }

  /** Sign-in: insert the session inside the T-SIGNIN transaction (the verified principal is already known). */
  async insertSession(
    tx: Tx,
    p: {
      id: string;
      tokenHash: Buffer;
      csrfHash: Buffer;
      principalId: string;
      personId: string;
      realm: 'patient_pool' | 'google';
      authTime: Date;
      amr: string[];
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<{ idleExpiresAt: Date; absoluteExpiresAt: Date }> {
    const now = this.now();
    const life = await lifetimesFor(tx, p.realm);
    const absoluteExpiresAt = new Date(now.getTime() + life.absoluteMs);
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + life.idleMs, absoluteExpiresAt.getTime()),
    );
    await tx.query(
      `INSERT INTO identity.session (id, organisation_id, token_hash, principal_id, person_id, realm, audience, auth_time, amr,
         csrf_hash, idle_expires_at, absolute_expires_at, last_seen_at, last_interaction_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14::inet, $15)`,
      [
        p.id,
        this.deps.orgId,
        p.tokenHash,
        p.principalId,
        p.personId,
        p.realm,
        AUDIENCE_OF[p.realm],
        p.authTime,
        p.amr,
        p.csrfHash,
        idleExpiresAt,
        absoluteExpiresAt,
        now,
        p.ip,
        p.userAgent === null ? null : p.userAgent.slice(0, 512),
      ],
    );
    return { idleExpiresAt, absoluteExpiresAt };
  }
}
