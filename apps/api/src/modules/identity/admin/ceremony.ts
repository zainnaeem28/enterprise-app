// The B2 ceremonies of ARCHITECTURE 26.1 and 26.3: admin sign-in, enrolment and elevation. Each verify step follows the same
// order: limit first, shape, consume the challenge in the first statement, pre-verification read, library verification,
// and only then the settings and the writes of the T-SIGNIN policies. Every refusal inside a transaction is RETURNED, not
// thrown, so the burn of the challenge (and the revocation on a counter regression) commits; the caller then counts the
// failure in its own short transaction and answers with the one generic code of the route.
import { createHmac } from 'node:crypto';
import type { KernelDb, Queue, ScopeSettings, Tx } from '@ehr/kernel';
import { AuditService } from '../../audit/index.js';
import { csrfTokenFor } from '../auth.controller.js';
import { EnrolmentFailedError, ElevationFailedError } from './errors.js';
import { IdentityValidationError, SignInFailedError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { SessionService } from '../sessions.js';
import type { SignInLimiter } from '../signin-limiter.js';
import { hashPresentedToken, issueToken, sha256 } from '../tokens.js';
import type { IssuedToken } from '../tokens.js';
import type { AuthContext } from '../types.js';
import { consumeChallenge, insertChallenge } from './challenges.js';
import { readClaim, setLocal } from './claims.js';
import type { Claim } from './claims.js';
import { decoyAllowCredentials } from './decoy.js';
import { normaliseHandle } from './handle.js';
import type { OptionsLimiter } from './options-limiter.js';
import { insertAdminSession } from './session.js';
import { ELEVATION_MINUTES, intSetting } from './settings.js';
import { parseAssertion, parseAttestation } from './webauthn.js';
import type { WebAuthnPort } from './webauthn.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const HANDLE_FAILURE_ALERT_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

export interface Client {
  ip: string;
  userAgent: string | null;
}

export interface CeremonyDeps {
  db: KernelDb;
  queue: Queue;
  audit: AuditService;
  sessions: SessionService;
  limiter: SignInLimiter;
  options: OptionsLimiter;
  port: WebAuthnPort;
  orgId: string;
  csrfKey: string;
  rateKey: string;
  /** `<env>/app/admin-decoy-key`. */
  decoyKey: string;
  /** Lower-case AAGUIDs kept by Cybersecurity (B2-3). Empty refuses every enrolment. */
  allowedAaguids: ReadonlySet<string>;
  now?: () => Date;
}

export interface OptionsResponse {
  challengeId: string;
  publicKey: unknown;
}

export interface SessionGrant {
  principalId: string;
  sessionId: string;
  token: IssuedToken;
  csrfToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

type Verdict<T> = ({ ok: true } & T) | { ok: false; principalId?: string };
const FAIL: { ok: false } = { ok: false };

/** The 16 bytes of a UUID, the WebAuthn user handle of an admin principal. */
const userHandleOf = (principalId: string): Buffer =>
  Buffer.from(principalId.replace(/-/g, ''), 'hex');

export class AdminCeremonies {
  constructor(private readonly d: CeremonyDeps) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }
  private anon(extra: Partial<ScopeSettings> = {}): ScopeSettings {
    return { audience: 'anonymous', orgId: this.d.orgId, ...extra };
  }

  // --- sign-in ----------------------------------------------------------------------------------------------------------

  /** POST /admin/auth/sign-in/options {handle} */
  async signInOptions(rawHandle: unknown, client: Client): Promise<OptionsResponse> {
    await this.d.options.hit(client.ip); // the first statement; 429 with no identity read
    const handle = normaliseHandle(rawHandle);
    if (handle === undefined) throw new IdentityValidationError(['handle']);
    const now = this.now();
    return this.d.db.withScope(this.anon(), async (tx) => {
      const claim = await readClaim(tx, handle);
      const ch = await insertChallenge(tx, {
        orgId: this.d.orgId,
        purpose: 'sign_in',
        principalId: claim.principalId ?? null,
        sessionId: null,
        now,
      });
      const allow =
        claim.principalId !== undefined && claim.credentials.length > 0
          ? claim.credentials.map((c) => ({ id: c.id, transports: c.transports }))
          : decoyAllowCredentials(this.d.decoyKey, handle);
      return {
        challengeId: ch.id,
        publicKey: await this.d.port.authenticationOptions({ challenge: ch.challenge, allow }),
      };
    });
  }

  /** POST /admin/auth/sign-in/verify {challengeId, handle, assertion}: 401 identity.sign_in_failed for every failure. */
  async signInVerify(input: unknown, client: Client): Promise<SessionGrant> {
    await this.d.limiter.assertAllowed(client.ip); // 429 before any verification work
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const handle = normaliseHandle(body['handle']);
    const assertion = parseAssertion(body['assertion']);
    const challengeId = body['challengeId'];
    if (handle === undefined || assertion === undefined || !isUuid(challengeId)) {
      await this.recordFailure(client.ip, handle, undefined);
      throw new SignInFailedError();
    }
    const token = issueToken();
    let verdict: Verdict<{ grant: SessionGrant }>;
    try {
      verdict = await this.d.db.withSignInScope(
        this.anon({ sessionTokenHash: token.hashHex, webauthnChallengeId: challengeId }),
        (tx) => this.signInTx(tx, { challengeId, handle, assertion }, token, client),
      );
    } catch (e) {
      await this.burn(challengeId);
      await this.recordFailure(client.ip, handle, undefined);
      throw e;
    }
    if (!verdict.ok) {
      await this.recordFailure(client.ip, handle, verdict.principalId);
      throw new SignInFailedError();
    }
    return verdict.grant;
  }

  private async signInTx(
    tx: import('@ehr/kernel').SignInTx,
    b: {
      challengeId: string;
      handle: string;
      assertion: NonNullable<ReturnType<typeof parseAssertion>>;
    },
    token: IssuedToken,
    client: Client,
  ): Promise<Verdict<{ grant: SessionGrant }>> {
    const now = this.now();
    const consumed = await consumeChallenge(tx, b.challengeId, 'sign_in', now);
    if (consumed === undefined) return FAIL;
    const claim = await readClaim(tx, b.handle);
    // An assertion for a credential of another principal than the challenge's is refused (38.2 item 8).
    if (claim.principalId === undefined || consumed.principalId !== claim.principalId) return FAIL;
    const cred = claim.credentials.find((c) => c.id.equals(b.assertion.rawId));
    if (cred === undefined) return FAIL;
    const v = await this.d.port.verifyAssertion({
      assertion: b.assertion,
      challenge: consumed.challenge,
      publicKey: cred.publicKey,
    });
    if (!v.ok) return { ok: false, principalId: claim.principalId };

    // Only after the signature verified: the settings that the T-SIGNIN policies match on, from the VERIFIED handle (CL-3).
    await tx.setAuthIdentity({ realm: 'admin_pool', subject: b.handle });
    const counter = await this.applyCounter(
      tx,
      cred.id,
      cred.signCount,
      v.presentedCounter,
      claim.principalId,
      now,
    );
    if (!counter) return { ok: false, principalId: claim.principalId };

    const pr = (
      await tx.query(
        `SELECT id, person_id, status FROM identity.principal WHERE realm = 'admin_pool' AND subject = $1`,
        [b.handle],
      )
    ).rows[0];
    if (pr === undefined || pr['status'] !== 'active' || pr['id'] !== claim.principalId)
      return { ok: false, principalId: claim.principalId };
    await tx.query(`UPDATE identity.principal SET last_sign_in_at = $2 WHERE id = $1`, [
      claim.principalId,
      now,
    ]);
    const grant = await this.createSession(tx, {
      principalId: claim.principalId,
      personId: pr['person_id'] as string,
      token,
      amr: ['hwk'],
      client,
      now,
    });
    await this.d.queue.enqueue(
      tx,
      'identity.record_sign_in',
      { principalId: claim.principalId, sessionId: grant.sessionId, kind: 'sign_in' },
      { jobKey: grant.sessionId },
    );
    return { ok: true, grant };
  }

  /**
   * The atomic counter rule (22.4, B2-4). Advancing: one UPDATE whose WHERE re-checks the counter. Not advancing against the
   * counter this transaction READ: a regression, so the credential is revoked (the caller then ends the ceremony with a
   * failure; the revocation commits). Advancing against what we read but losing the UPDATE: a concurrent duplicate
   * presentation, refused without a revocation, so it can never revoke falsely.
   */
  private async applyCounter(
    tx: Tx,
    credentialId: Buffer,
    stored: number,
    presented: number,
    principalId: string,
    now: Date,
  ): Promise<boolean> {
    const advances = presented > stored || (stored === 0 && presented === 0);
    if (!advances) {
      await tx.query(
        `UPDATE identity.admin_credential SET revoked_at = $2, revoke_reason = 'counter_regression'
          WHERE id = $1 AND revoked_at IS NULL`,
        [credentialId, now],
      );
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        { kind: 'counter_regression', principalId },
        { jobKey: `counter_regression:${principalId}:${now.getTime()}` },
      );
      return false;
    }
    const r = await tx.query(
      `UPDATE identity.admin_credential SET sign_count = $2, last_used_at = $3
        WHERE id = $1 AND revoked_at IS NULL AND (sign_count < $2 OR (sign_count = 0 AND $2 = 0))`,
      [credentialId, presented, now],
    );
    return (r.rowCount ?? 0) === 1;
  }

  private async createSession(
    tx: Tx,
    p: {
      principalId: string;
      personId: string;
      token: IssuedToken;
      amr: string[];
      client: Client;
      now: Date;
    },
  ): Promise<SessionGrant> {
    const sessionId = uuidv7();
    const csrfToken = csrfTokenFor(this.d.csrfKey, sessionId);
    const life = await insertAdminSession(tx, {
      id: sessionId,
      orgId: this.d.orgId,
      tokenHash: p.token.hash,
      csrfHash: sha256(csrfToken),
      principalId: p.principalId,
      personId: p.personId,
      amr: p.amr,
      ip: p.client.ip === 'unknown' ? null : p.client.ip,
      userAgent: p.client.userAgent,
      now: p.now,
    });
    return { principalId: p.principalId, sessionId, token: p.token, csrfToken, ...life };
  }

  // --- enrolment ----------------------------------------------------------------------------------------------------------

  /** POST /admin/auth/enrolment/options {handle, token}: 401 identity.enrolment_failed for every failure. */
  async enrolmentOptions(input: unknown, client: Client): Promise<OptionsResponse> {
    await this.d.options.hit(client.ip);
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const handle = normaliseHandle(body['handle']);
    const tokenHash = hashPresentedToken(
      typeof body['token'] === 'string' ? body['token'] : undefined,
    );
    if (handle === undefined || tokenHash === undefined) throw new EnrolmentFailedError();
    const now = this.now();
    const out = await this.d.db.withScope(
      this.anon(),
      async (tx): Promise<OptionsResponse | undefined> => {
        const claim = await readClaim(tx, handle);
        const tok = await this.lookupToken(tx, tokenHash, now);
        if (
          claim.principalId === undefined ||
          tok === undefined ||
          tok.principalId !== claim.principalId
        )
          return undefined;
        const ch = await insertChallenge(tx, {
          orgId: this.d.orgId,
          purpose: 'enrol',
          principalId: claim.principalId,
          sessionId: null,
          now,
        });
        return {
          challengeId: ch.id,
          publicKey: await this.d.port.registrationOptions({
            challenge: ch.challenge,
            handle,
            userId: userHandleOf(claim.principalId),
            exclude: claim.credentials.map((c) => ({ id: c.id, transports: c.transports })),
          }),
        };
      },
    );
    if (out === undefined) throw new EnrolmentFailedError();
    return out;
  }

  /** POST /admin/auth/enrolment/verify {challengeId, handle, token, attestation} */
  async enrolmentVerify(input: unknown, client: Client): Promise<SessionGrant> {
    await this.d.limiter.assertAllowed(client.ip);
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const handle = normaliseHandle(body['handle']);
    const tokenHash = hashPresentedToken(
      typeof body['token'] === 'string' ? body['token'] : undefined,
    );
    const attestation = parseAttestation(body['attestation']);
    const challengeId = body['challengeId'];
    if (
      handle === undefined ||
      tokenHash === undefined ||
      attestation === undefined ||
      !isUuid(challengeId)
    ) {
      await this.recordFailure(client.ip, handle, undefined);
      throw new EnrolmentFailedError();
    }
    const token = issueToken();
    let verdict: Verdict<{ grant: SessionGrant }>;
    try {
      verdict = await this.d.db.withSignInScope(
        this.anon({ sessionTokenHash: token.hashHex, webauthnChallengeId: challengeId }),
        (tx) =>
          this.enrolmentTx(tx, { challengeId, handle, tokenHash, attestation }, token, client),
      );
    } catch (e) {
      await this.burn(challengeId);
      await this.recordFailure(client.ip, handle, undefined);
      throw e;
    }
    if (!verdict.ok) {
      await this.recordFailure(client.ip, handle, verdict.principalId);
      throw new EnrolmentFailedError();
    }
    return verdict.grant;
  }

  private async enrolmentTx(
    tx: import('@ehr/kernel').SignInTx,
    b: { challengeId: string; handle: string; tokenHash: string; attestation: unknown },
    token: IssuedToken,
    client: Client,
  ): Promise<Verdict<{ grant: SessionGrant }>> {
    const now = this.now();
    const consumed = await consumeChallenge(tx, b.challengeId, 'enrol', now);
    if (consumed === undefined) return FAIL;
    const tok = await this.lookupToken(tx, b.tokenHash, now);
    const claim: Claim = await readClaim(tx, b.handle);
    if (
      tok === undefined ||
      claim.principalId === undefined ||
      tok.principalId !== claim.principalId ||
      consumed.principalId !== claim.principalId
    )
      return FAIL;
    const v = await this.d.port.verifyAttestation({
      response: b.attestation,
      challenge: consumed.challenge,
    });
    if (!v.ok) return { ok: false, principalId: claim.principalId };
    const k = v.key;
    // B2-3: an AAGUID Cybersecurity has not approved, any BE/BS credential, and a key that did not verify the user are refused.
    if (
      !this.d.allowedAaguids.has(k.aaguid.toLowerCase()) ||
      k.backupEligible ||
      k.backedUp ||
      !k.userVerified
    )
      return { ok: false, principalId: claim.principalId };

    await tx.setAuthIdentity({ realm: 'admin_pool', subject: b.handle });
    // BE05-R3-S01: the token is single-use. The row is locked and re-checked as still approved, so of two concurrent
    // verifies exactly one proceeds; the token is spent with the first key (the second key needs the enrolment session).
    const live = await tx.query(
      `SELECT 1 FROM identity.enrolment_token WHERE id = $1 AND status = 'approved' AND used_at IS NULL FOR UPDATE`,
      [tok.id],
    );
    if (live.rows.length !== 1) return { ok: false, principalId: claim.principalId };
    const ins = await tx.query(
      `INSERT INTO identity.admin_credential (id, organisation_id, principal_id, public_key, sign_count, aaguid, transports,
         backup_eligible, user_verified_at_enrol, enrolment_token_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, false, true, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        k.credentialId,
        this.d.orgId,
        claim.principalId,
        k.publicKey,
        k.aaguid.toLowerCase(),
        k.transports,
        tok.id,
      ],
    );
    if ((ins.rowCount ?? 0) !== 1) return { ok: false, principalId: claim.principalId };
    await tx.query(
      `UPDATE identity.enrolment_token SET status = 'used', used_at = $2 WHERE id = $1`,
      [tok.id, now],
    );

    const pr = (
      await tx.query(
        `SELECT person_id, status FROM identity.principal WHERE realm = 'admin_pool' AND subject = $1`,
        [b.handle],
      )
    ).rows[0];
    if (pr === undefined || pr['status'] !== 'active')
      return { ok: false, principalId: claim.principalId };
    await tx.query(`UPDATE identity.principal SET last_sign_in_at = $2 WHERE id = $1`, [
      claim.principalId,
      now,
    ]);
    const grant = await this.createSession(tx, {
      principalId: claim.principalId,
      personId: pr['person_id'] as string,
      token,
      amr: ['hwk', 'enrol'],
      client,
      now,
    });
    await this.d.queue.enqueue(
      tx,
      'identity.record_sign_in',
      { principalId: claim.principalId, sessionId: grant.sessionId, kind: 'sign_in' },
      { jobKey: grant.sessionId },
    );
    // B2-9: the audit event `enrol`, the compliance alert and the security-contact notice are written by the worker.
    await this.d.queue.enqueue(
      tx,
      'identity.admin_event',
      { kind: 'credential_enrolled', principalId: claim.principalId, sessionId: grant.sessionId },
      { jobKey: `credential_enrolled:${grant.sessionId}` },
    );
    return { ok: true, grant };
  }

  /**
   * POST /admin/auth/enrolment/second-key/options (BE05-R3-S01, B2-8): the second key, from the session the enrolment created
   * (amr 'enrol') while the principal holds exactly one live key that came from that enrolment. No token is involved.
   */
  async secondKeyOptions(ctx: AuthContext): Promise<OptionsResponse> {
    const now = this.now();
    const out = await this.d.db.withScope(ctx.scope, async (tx) => {
      await setLocal(tx, 'app.session_id', ctx.session.id);
      const first = await this.secondKeyBase(tx, ctx);
      if (first === undefined) return undefined;
      const ch = await insertChallenge(tx, {
        orgId: this.d.orgId,
        purpose: 'enrol',
        principalId: ctx.session.principalId,
        sessionId: ctx.session.id,
        now,
      });
      return {
        challengeId: ch.id,
        publicKey: await this.d.port.registrationOptions({
          challenge: ch.challenge,
          handle: first.handle,
          userId: userHandleOf(ctx.session.principalId),
          exclude: first.exclude,
        }),
      };
    });
    if (out === undefined) throw new EnrolmentFailedError();
    return out;
  }

  /** POST /admin/auth/enrolment/second-key/verify {challengeId, attestation}: registers the second key. */
  async secondKeyVerify(ctx: AuthContext, input: unknown): Promise<{ enrolled: true }> {
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const attestation = parseAttestation(body['attestation']);
    const challengeId = body['challengeId'];
    if (attestation === undefined || !isUuid(challengeId)) throw new EnrolmentFailedError();
    const now = this.now();
    const scope: ScopeSettings = { ...ctx.scope, webauthnChallengeId: challengeId };
    const verdict = await this.d.db.withScope(scope, async (tx): Promise<Verdict<object>> => {
      await setLocal(tx, 'app.session_id', ctx.session.id);
      const consumed = await consumeChallenge(tx, challengeId, 'enrol', now);
      if (consumed === undefined || consumed.principalId !== ctx.session.principalId) return FAIL;
      // One enrolment at a time per principal, so the two-key limit holds under concurrency.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `admin_second_key:${ctx.session.principalId}`,
      ]);
      const first = await this.secondKeyBase(tx, ctx);
      if (first === undefined) return FAIL;
      const v = await this.d.port.verifyAttestation({
        response: attestation,
        challenge: consumed.challenge,
      });
      if (!v.ok) return FAIL;
      const k = v.key;
      if (
        !this.d.allowedAaguids.has(k.aaguid.toLowerCase()) ||
        k.backupEligible ||
        k.backedUp ||
        !k.userVerified
      )
        return FAIL;
      const ins = await tx.query(
        `INSERT INTO identity.admin_credential (id, organisation_id, principal_id, public_key, sign_count, aaguid, transports,
           backup_eligible, user_verified_at_enrol, enrolment_token_id)
         VALUES ($1, $2, $3, $4, 0, $5, $6, false, true, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          k.credentialId,
          this.d.orgId,
          ctx.session.principalId,
          k.publicKey,
          k.aaguid.toLowerCase(),
          k.transports,
          first.tokenId,
        ],
      );
      if ((ins.rowCount ?? 0) !== 1) return FAIL;
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        {
          kind: 'credential_enrolled',
          principalId: ctx.session.principalId,
          sessionId: ctx.session.id,
        },
        { jobKey: `credential_enrolled:${ctx.session.id}:${challengeId}` },
      );
      return { ok: true };
    });
    if (!verdict.ok) throw new EnrolmentFailedError();
    return { enrolled: true };
  }

  /** The session must carry amr 'enrol' and the principal hold exactly one credential (never revoked) from one token. */
  private async secondKeyBase(
    tx: Tx,
    ctx: AuthContext,
  ): Promise<
    { tokenId: string; handle: string; exclude: { id: Buffer; transports: string[] }[] } | undefined
  > {
    const amr = (
      await tx.query(`SELECT amr FROM identity.session WHERE id = $1 AND revoked_at IS NULL`, [
        ctx.session.id,
      ])
    ).rows[0]?.['amr'] as string[] | undefined;
    if (amr === undefined || !amr.includes('enrol')) return undefined;
    const creds = (
      await tx.query(
        `SELECT id, transports, enrolment_token_id, revoked_at FROM identity.admin_credential WHERE principal_id = $1`,
        [ctx.session.principalId],
      )
    ).rows;
    if (creds.length !== 1 || creds[0]?.['revoked_at'] !== null) return undefined;
    const handle = (
      await tx.query(`SELECT subject FROM identity.principal WHERE id = $1`, [
        ctx.session.principalId,
      ])
    ).rows[0]?.['subject'] as string | undefined;
    if (handle === undefined) return undefined;
    return {
      tokenId: creds[0]['enrolment_token_id'] as string,
      handle,
      exclude: creds.map((c) => ({
        id: c['id'] as Buffer,
        transports: (c['transports'] as string[] | null) ?? [],
      })),
    };
  }

  /** The enrolment token by the hash of the presented token (21.3 item 4), if approved and unexpired. */
  private async lookupToken(
    tx: Tx,
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string; principalId: string } | undefined> {
    await setLocal(tx, 'app.auth_enrolment_token_hash', tokenHash);
    const r = await tx.query(
      `SELECT id, principal_id FROM identity.enrolment_token
        WHERE token_hash = decode($1, 'hex') AND status = 'approved' AND expires_at > $2 AND used_at IS NULL`,
      [tokenHash, now],
    );
    const row = r.rows[0];
    return row === undefined
      ? undefined
      : { id: row['id'] as string, principalId: row['principal_id'] as string };
  }

  // --- elevation ------------------------------------------------------------------------------------------------------------

  /** POST /admin/auth/elevation/options: a challenge bound to the current session (SEC01-F-06). */
  async elevationOptions(ctx: AuthContext): Promise<OptionsResponse> {
    const now = this.now();
    const out = await this.d.db.withScope(ctx.scope, async (tx) => {
      await setLocal(tx, 'app.session_id', ctx.session.id);
      const creds = await tx.query(
        `SELECT id, transports FROM identity.admin_credential WHERE principal_id = $1 AND revoked_at IS NULL ORDER BY id`,
        [ctx.session.principalId],
      );
      if (creds.rows.length === 0) return undefined;
      const ch = await insertChallenge(tx, {
        orgId: this.d.orgId,
        purpose: 'elevation',
        principalId: ctx.session.principalId,
        sessionId: ctx.session.id,
        now,
      });
      return {
        challengeId: ch.id,
        publicKey: await this.d.port.authenticationOptions({
          challenge: ch.challenge,
          allow: creds.rows.map((r) => ({
            id: r['id'] as Buffer,
            transports: (r['transports'] as string[] | null) ?? [],
          })),
        }),
      };
    });
    if (out === undefined) throw new ElevationFailedError();
    return out;
  }

  /** POST /admin/auth/elevation/verify {challengeId, assertion}: a 15-minute grant bound to the session, token rotated. */
  async elevationVerify(
    ctx: AuthContext,
    input: unknown,
    meta: { requestId: string | null; ip: string | null; userAgent: string | null },
  ): Promise<{ elevationExpiresAt: Date; token: IssuedToken }> {
    const body = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    const assertion = parseAssertion(body['assertion']);
    const challengeId = body['challengeId'];
    if (assertion === undefined || !isUuid(challengeId)) throw new ElevationFailedError();
    const token = issueToken();
    const now = this.now();
    const scope: ScopeSettings = { ...ctx.scope, webauthnChallengeId: challengeId };
    const verdict = await this.d.db.withScope(
      scope,
      async (tx): Promise<Verdict<{ expiresAt: Date }>> => {
        await setLocal(tx, 'app.session_id', ctx.session.id);
        const consumed = await consumeChallenge(tx, challengeId, 'elevation', now);
        if (consumed === undefined || consumed.principalId !== ctx.session.principalId) return FAIL;
        const c = (
          await tx.query(
            `SELECT id, public_key, sign_count FROM identity.admin_credential
            WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL`,
            [assertion.rawId, ctx.session.principalId],
          )
        ).rows[0];
        if (c === undefined) return FAIL;
        const v = await this.d.port.verifyAssertion({
          assertion,
          challenge: consumed.challenge,
          publicKey: c['public_key'] as Buffer,
        });
        if (!v.ok) return FAIL;
        if (
          !(await this.applyCounter(
            tx,
            assertion.rawId,
            Number(c['sign_count']),
            v.presentedCounter,
            ctx.session.principalId,
            now,
          ))
        )
          return FAIL;

        // B2-8: with one live credential, only the session the enrolment created may be elevated.
        const live = Number(
          (
            await tx.query(
              `SELECT count(*) AS n FROM identity.admin_credential WHERE principal_id = $1 AND revoked_at IS NULL`,
              [ctx.session.principalId],
            )
          ).rows[0]?.['n'] ?? 0,
        );
        if (live < 2) {
          const amr = (
            await tx.query(
              `SELECT amr FROM identity.session WHERE id = $1 AND revoked_at IS NULL`,
              [ctx.session.id],
            )
          ).rows[0]?.['amr'] as string[] | undefined;
          if (amr === undefined || !amr.includes('enrol')) return FAIL;
        }

        const minutes = await intSetting(
          tx,
          ELEVATION_MINUTES.key,
          ELEVATION_MINUTES.dflt,
          ELEVATION_MINUTES.min,
          ELEVATION_MINUTES.max,
        );
        const expiresAt = new Date(now.getTime() + minutes * 60_000);
        await tx.query(
          `INSERT INTO identity.elevation_grant (id, organisation_id, session_id, person_id, issued_at, expires_at, assertion_at, method, credential_id)
         VALUES ($1, $2, $3, $4, $5, $6, $5, 'webauthn_api', $7)`,
          [
            uuidv7(),
            this.d.orgId,
            ctx.session.id,
            ctx.session.personId,
            now,
            expiresAt,
            assertion.rawId,
          ],
        );
        // Rotation at elevation (26.2): the token hash of the same row changes; the CSRF secret derives from the session ID.
        await tx.query(
          `UPDATE identity.session SET token_hash = $2 WHERE id = $1 AND revoked_at IS NULL`,
          [ctx.session.id, token.hash],
        );
        await this.d.audit.record(tx, {
          requestId: meta.requestId,
          action: 'elevation',
          resourceType: 'identity.session',
          resourceId: ctx.session.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return { ok: true, expiresAt };
      },
    );
    if (!verdict.ok) {
      await this.burnElevation(ctx, challengeId);
      throw new ElevationFailedError();
    }
    return { elevationExpiresAt: verdict.expiresAt, token };
  }

  // --- failure accounting ----------------------------------------------------------------------------------------------------

  /** A challenge that was not consumed because the transaction failed unexpectedly is burned in its own transaction. */
  private async burn(challengeId: string): Promise<void> {
    try {
      await this.d.db.withScope(this.anon({ webauthnChallengeId: challengeId }), (tx) =>
        tx.query(
          `UPDATE identity.webauthn_challenge SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
          [challengeId, this.now()],
        ),
      );
    } catch {
      // the challenge expires in two minutes anyway
    }
  }

  private async burnElevation(ctx: AuthContext, challengeId: string): Promise<void> {
    try {
      await this.d.db.withScope({ ...ctx.scope, webauthnChallengeId: challengeId }, async (tx) => {
        await setLocal(tx, 'app.session_id', ctx.session.id);
        await tx.query(
          `UPDATE identity.webauthn_challenge SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
          [challengeId, this.now()],
        );
      });
    } catch {
      // expires in two minutes anyway
    }
  }

  /**
   * The failure counts of 31.3, each in its own short transaction after the request's transaction has ended: the per-IP count
   * (which refuses at its limit) and the per-handle count (which never refuses; at 20 an hour it raises a compliance alert).
   */
  private async recordFailure(
    ip: string,
    handle: string | undefined,
    principalId: string | undefined,
  ): Promise<void> {
    await this.d.limiter.recordFailure(ip, 'admin_pool');
    if (handle === undefined) return;
    try {
      const now = this.now().getTime();
      const start = Math.floor(now / HOUR_MS) * HOUR_MS;
      const key = `signin_handle:${createHmac('sha256', this.d.rateKey).update(handle).digest('hex')}`;
      await this.d.db.withScope(this.anon(), async (tx) => {
        const r = await tx.query(
          `INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count)
           VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
           ON CONFLICT (organisation_id, key, window_start) DO UPDATE SET count = kernel.rate_counter.count + 1, updated_at = now()
           RETURNING count`,
          [this.d.orgId, key, start],
        );
        if (
          Number(r.rows[0]?.['count']) === HANDLE_FAILURE_ALERT_PER_HOUR &&
          principalId !== undefined
        )
          await this.d.queue.enqueue(
            tx,
            'identity.admin_event',
            { kind: 'handle_failures', principalId },
            { jobKey: `handle_failures:${principalId}:${start}` },
          );
      });
    } catch {
      // counting must never hide the refusal
    }
  }
}
