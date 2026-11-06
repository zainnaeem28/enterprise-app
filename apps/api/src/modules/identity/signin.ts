// Sign-in provisioning (ARCHITECTURE 26.1, TDR-01): one transaction per callback under the T-SIGNIN policies, audience
// `anonymous`, after the IdP's ID token has been verified. No definer function is involved.
//   - existing principal (realm, sub):     update last_sign_in_at, insert the session;
//   - pre-registered google principal:     bind `sub` ONCE by the verified, lower-cased email (the column trigger forbids a
//                                          second binding), within `preregistration_days`, then insert the session;
//   - unknown:                             insert person and principal with NO roles, then the session.
// A disabled or suspended principal, an expired pre-registration and every other refusal end as the same generic
// SignInFailedError. The audit event and the notice for provisioning and binding are queued in the same transaction
// (`identity.record_sign_in`): the `anonymous` audience cannot write to `audit.event` (21.3 list, AUD-N1).
import type { KernelDb, Queue } from '@ehr/kernel';
import { SignInFailedError } from './errors.js';
import { uuidv7 } from './ids.js';
import type { VerifiedIdentity } from './realms.js';
import type { SessionService } from './sessions.js';
import { sha256 } from './tokens.js';
import type { IssuedToken } from './tokens.js';

export type SignInKind = 'sign_in' | 'created' | 'bound';

export interface SignInResult {
  kind: SignInKind;
  principalId: string;
  personId: string;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export const DEFAULT_PREREGISTRATION_DAYS = 30;

export interface SignInDeps {
  db: KernelDb;
  orgId: string;
  sessions: SessionService;
  queue: Queue;
  now?: () => Date;
}

class RetryProvisioning extends Error {}

export class SignInService {
  constructor(private readonly d: SignInDeps) {}

  /** `csrfFor(sessionId)` derives the CSRF token of the new session; only its hash is stored (26.2). */
  async signIn(
    identity: VerifiedIdentity,
    token: IssuedToken,
    client: { ip: string | null; userAgent: string | null },
    csrfFor: (sessionId: string) => string,
  ): Promise<SignInResult> {
    // A concurrent first sign-in of the same subject loses on the unique constraint; the retry then finds the principal.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(identity, token, csrfFor, client);
      } catch (e) {
        if (e instanceof RetryProvisioning && attempt < 2) continue;
        if (e instanceof RetryProvisioning) throw new SignInFailedError();
        throw e;
      }
    }
  }

  private async once(
    identity: VerifiedIdentity,
    token: IssuedToken,
    csrfFor: (sessionId: string) => string,
    client: { ip: string | null; userAgent: string | null },
  ): Promise<SignInResult> {
    const now = (this.d.now ?? (() => new Date()))();
    return this.d.db.withSignInScope(
      { audience: 'anonymous', orgId: this.d.orgId, sessionTokenHash: token.hashHex },
      async (tx) => {
        // Only now, after the IdP verification, are the T-SIGNIN settings set (21.3).
        await tx.setAuthIdentity({
          realm: identity.realm,
          subject: identity.subject,
          ...(identity.email === undefined ? {} : { email: identity.email }),
        });

        const found = (
          await tx.query(
            `SELECT id, person_id, status, subject, COALESCE(preregistered_at, created_at) AS registered_at
             FROM identity.principal
            WHERE realm = $1 AND (subject = $2 OR ($1 = 'google' AND subject IS NULL AND lower(email) = $3))
            ORDER BY (subject IS NULL) LIMIT 1`,
            [identity.realm, identity.subject, identity.email ?? null],
          )
        ).rows[0];

        let kind: SignInKind = 'sign_in';
        let principalId: string;
        let personId: string;
        if (found !== undefined) {
          if (found['status'] !== 'active') throw new SignInFailedError();
          principalId = found['id'] as string;
          personId = found['person_id'] as string;
          if (found['subject'] === null) {
            const days = await this.preregistrationDays(tx);
            const registeredAt = found['registered_at'] as Date;
            if (now.getTime() - registeredAt.getTime() > days * 86_400_000)
              throw new SignInFailedError(); // re-issue the pre-registration
            // Binds at most once: a concurrent second sign-in updates 0 rows (the WHERE re-checks `subject IS NULL`).
            const bound = await tx.query(
              `UPDATE identity.principal SET subject = $2, last_sign_in_at = $3 WHERE id = $1 AND subject IS NULL`,
              [principalId, identity.subject, now],
            );
            if ((bound.rowCount ?? 0) === 1) kind = 'bound';
            else {
              const again = (
                await tx.query(`SELECT id FROM identity.principal WHERE id = $1 AND subject = $2`, [
                  principalId,
                  identity.subject,
                ])
              ).rows[0];
              if (again === undefined) throw new SignInFailedError(); // bound to someone else in the meantime
              await tx.query(`UPDATE identity.principal SET last_sign_in_at = $2 WHERE id = $1`, [
                principalId,
                now,
              ]);
            }
          } else {
            await tx.query(`UPDATE identity.principal SET last_sign_in_at = $2 WHERE id = $1`, [
              principalId,
              now,
            ]);
          }
        } else {
          if (identity.realm === 'google' && identity.email === undefined)
            throw new SignInFailedError();
          personId = uuidv7();
          principalId = uuidv7();
          kind = 'created';
          await tx.query(
            `INSERT INTO identity.person (id, organisation_id, display_name, status) VALUES ($1, $2, $3, 'active')`,
            [personId, this.d.orgId, identity.displayName],
          );
          try {
            await tx.query(
              `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status, last_sign_in_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
              [
                principalId,
                this.d.orgId,
                personId,
                identity.realm,
                identity.subject,
                identity.email ?? null,
                now,
              ],
            );
          } catch (e) {
            if ((e as { code?: string }).code === '23505') throw new RetryProvisioning();
            throw e;
          }
        }

        const sessionId = uuidv7();
        const life = await this.d.sessions.insertSession(tx, {
          id: sessionId,
          tokenHash: token.hash,
          csrfHash: sha256(csrfFor(sessionId)),
          principalId,
          personId,
          realm: identity.realm,
          authTime: identity.authTime,
          amr: identity.amr,
          ip: client.ip,
          userAgent: client.userAgent,
        });
        await this.d.queue.enqueue(
          tx,
          'identity.record_sign_in',
          { principalId, sessionId, kind },
          { jobKey: sessionId },
        );
        return { kind, principalId, personId, sessionId, ...life };
      },
    );
  }

  private async preregistrationDays(tx: {
    query(sql: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  }): Promise<number> {
    const r = await tx.query(
      `SELECT value FROM kernel.setting WHERE key = 'preregistration_days' AND location_id IS NULL`,
    );
    const v = r.rows[0]?.['value'];
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 30
      ? v
      : DEFAULT_PREREGISTRATION_DAYS;
  }
}
