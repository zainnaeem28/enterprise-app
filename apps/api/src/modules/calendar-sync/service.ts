// The calendar link of a doctor (ARCHITECTURE 24 `linkStart`, `linkComplete`, `unlink`, `status`; 25.9; 29.3; SA-DP-06).
//
// The first API path that writes a secret on behalf of a non-admin: the OAuth callback stores the doctor's refresh token ONLY as an
// outbound secret reference. The value goes to the secret store (idempotent token) and the reference (name + version ID) and the audit
// row (`secret_write`, version ID) are written in the same transaction as the link's change of state. The token, the authorisation
// code and the state appear in no log, response, job payload, audit row or error (canary test).
import { createHash } from 'node:crypto';
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import type { AuditService, RequestMeta } from '../audit/index.js';
import type { OutboundSecretStore } from '../integration-core/index.js';
import {
  CalendarLinkNotFoundError,
  CalendarScopeError,
  CalendarUnavailableError,
  CalendarValidationError,
} from './errors.js';
import { tokenSecretName } from './ids.js';
import { OAuthExchangeError, type OAuthPort } from './oauth.js';
import { makeState, pkceChallenge, pkceVerifier, signingKey, verifyState } from './state.js';

export interface CalendarLinkDeps {
  db: KernelDb;
  audit: AuditService;
  /** API-tier queue (`queue_api.enqueue`). */
  queue: Queue;
  store: OutboundSecretStore;
  oauth: OAuthPort;
  /** Application secrets that sign the OAuth state: current first, then the previous one (rotation). */
  stateKeys: readonly Buffer[];
  logger?: Logger;
  now?: () => Date;
}

export type LinkStatus = 'not_linked' | 'pending_consent' | 'active' | 'token_revoked' | 'error';

export interface LinkView {
  status: LinkStatus;
  googleCalendarId?: string;
  lastSyncedAt?: string | null;
  lastErrorCode?: string | null;
}

export type CallbackOutcome = 'linked' | 'denied' | 'error';

const GOOGLE_CODE = /^[\x21-\x7e]{1,2048}$/; // printable ASCII, no space: the shape of an authorisation code

export class CalendarLinkService {
  constructor(private readonly d: CalendarLinkDeps) {
    if (d.stateKeys.length === 0) throw new Error('calendar link: at least one state key is required');
  }

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  /** The caller's own principal, or 403: a google-realm staff scope with a principal. */
  private own(tx: Tx): string {
    const s = tx.scope;
    if (s.audience !== 'staff' || s.realm !== 'google' || s.orgId === undefined || s.principalId === undefined)
      throw new CalendarScopeError();
    return s.principalId.toLowerCase();
  }

  /** `status` (24): the doctor's own link. Never a token, a sync token or a secret name. */
  async status(tx: Tx): Promise<LinkView> {
    const principal = this.own(tx);
    const r = await tx.query(
      `SELECT status, google_calendar_id, last_synced_at, last_error_code
         FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid`,
      [principal],
    );
    const row = r.rows[0];
    if (row === undefined) return { status: 'not_linked' };
    return {
      status: row.status as LinkStatus,
      googleCalendarId: String(row.google_calendar_id),
      lastSyncedAt: row.last_synced_at === null ? null : (row.last_synced_at as Date).toISOString(),
      lastErrorCode: (row.last_error_code as string | null) ?? null,
    };
  }

  /**
   * `linkStart` (24): the URL the browser is sent to. A first start creates the link `pending_consent`; an existing link (a re-link, or
   * a link in trouble) is left as it is until the callback succeeds, so an abandoned consent pauses nothing.
   */
  async start(tx: Tx, meta: RequestMeta): Promise<{ authorizationUrl: string }> {
    const principal = this.own(tx);
    const org = tx.scope.orgId as string;
    const ins = await tx.query(
      `INSERT INTO calendar_sync.calendar_link
         (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, created_by)
       VALUES ($1::uuid, $2::uuid, 'primary', 'pending_consent', $3, $1::uuid)
       ON CONFLICT (clinician_principal_id) DO NOTHING`,
      [principal, org, tokenSecretName(principal)],
    );
    if ((ins.rowCount ?? 0) > 0) {
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'calendar_sync.calendar_link',
        resourceId: principal,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: 'pending_consent' },
      });
    }
    const state = makeState(this.d.stateKeys[0] as Buffer, principal, this.now());
    const verifier = pkceVerifier(this.d.stateKeys[0] as Buffer, state);
    return {
      authorizationUrl: this.d.oauth.authorizationUrl({ state, codeChallenge: pkceChallenge(verifier) }),
    };
  }

  /**
   * `linkComplete` (24): the browser comes back with `?code&state` (or `?error`). The state is checked first (400 for a bad one: nothing
   * is read or exchanged). The code is exchanged OUTSIDE any transaction, so no connection is held during the vendor call. Then one
   * transaction stores the token reference, activates the link and enqueues the first listing (marker `initial`) and the watch channel.
   */
  async complete(
    scope: Parameters<KernelDb['withScope']>[0],
    meta: RequestMeta,
    q: { code?: unknown; state?: unknown; error?: unknown },
  ): Promise<CallbackOutcome> {
    if (scope.audience !== 'staff' || scope.realm !== 'google' || scope.principalId === undefined)
      throw new CalendarScopeError();
    const principal = scope.principalId.toLowerCase();
    const verified = verifyState(this.d.stateKeys, q.state, principal, this.now());
    if (verified === undefined) throw new CalendarValidationError(['state']);
    if (q.error !== undefined) return 'denied'; // the doctor declined at Google; the value of `error` is not used
    if (typeof q.code !== 'string' || !GOOGLE_CODE.test(q.code)) throw new CalendarValidationError(['code']);
    const key = signingKey(this.d.stateKeys, q.state as string) as Buffer;

    // The connection must exist and be enabled BEFORE the single-use code is spent.
    const connectionId = await this.d.db.withScope(scope, async (tx) => {
      const r = await tx.query(
        `SELECT id FROM integration_core.connection WHERE kind = 'google_calendar' AND enabled`,
      );
      return r.rows[0]?.id as string | undefined;
    });
    if (connectionId === undefined) throw new CalendarUnavailableError();

    let refreshToken: string;
    try {
      ({ refreshToken } = await this.d.oauth.exchangeCode({
        code: q.code,
        codeVerifier: pkceVerifier(key, q.state as string),
      }));
    } catch (e) {
      this.d.logger?.warn('calendar link: code exchange failed', {
        reason: e instanceof OAuthExchangeError ? e.reason : 'unexpected',
      });
      return 'error';
    }

    const name = tokenSecretName(principal);
    // The same callback retried (the browser's back button) writes no second version.
    const clientToken = createHash('sha256')
      .update(`${principal}\u0000calendar\u0000${verified.nonce}`)
      .digest('hex');
    await this.d.db.withScope(scope, async (tx) => {
      const org = tx.scope.orgId as string;
      let stored: { arn: string; versionId: string };
      try {
        stored = await this.d.store.put({ connectionId, name }, refreshToken, clientToken);
      } catch {
        throw new CalendarUnavailableError(); // no vendor text, no value
      }
      await tx.query(
        `INSERT INTO integration_core.secret_ref
           (connection_id, name, organisation_id, class, secret_arn, current_version_id, rotated_at, rotated_by_person_id, created_by)
         VALUES ($1::uuid, $2, $3::uuid, 'outbound', $4, $5, now(), $6::uuid, $7::uuid)
         ON CONFLICT (connection_id, name) DO UPDATE
           SET secret_arn = EXCLUDED.secret_arn, current_version_id = EXCLUDED.current_version_id,
               rotated_at = now(), rotated_by_person_id = EXCLUDED.rotated_by_person_id`,
        [connectionId, name, org, stored.arn, stored.versionId, tx.scope.personId ?? null, principal],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'secret_write',
        resourceType: 'integration_core.secret_ref',
        resourceId: connectionId,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { name, versionId: stored.versionId }, // the version ID, never the value (BD-08)
      });
      await tx.query(
        `INSERT INTO calendar_sync.calendar_link
           (clinician_principal_id, organisation_id, google_calendar_id, status, token_secret_name, created_by)
         VALUES ($1::uuid, $2::uuid, 'primary', 'pending_consent', $3, $1::uuid)
         ON CONFLICT (clinician_principal_id) DO NOTHING`,
        [principal, org, name],
      );
      // A new link (or a re-link) owes a full listing: the old sync token belongs to the previous consent.
      await tx.query(
        `UPDATE calendar_sync.calendar_link
            SET status = 'active', google_calendar_id = 'primary', sync_token = NULL, last_error_code = NULL
          WHERE clinician_principal_id = $1::uuid`,
        [principal],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'calendar_sync.calendar_link',
        resourceId: principal,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { status: 'active' },
      });
      // ARCHITECTURE 33.1 / 25 "First sync": in the transaction that makes the link active.
      await this.d.queue.enqueue(
        tx,
        'calendar_sync.full_resync',
        { clinicianId: principal, marker: 'initial' },
        { jobKey: `resync_${principal}_initial` },
      );
      await this.d.queue.enqueue(
        tx,
        'calendar_sync.renew_watch',
        { clinicianId: principal },
        { jobKey: `renew_${principal}` },
      );
    });
    return 'linked';
  }

  /** `unlink` (24): removes the link; the cleanup job clears the busy blocks, channels and Busy events (departure D3). */
  async unlink(tx: Tx, meta: RequestMeta): Promise<void> {
    const principal = this.own(tx);
    const r = await tx.query(
      `DELETE FROM calendar_sync.calendar_link WHERE clinician_principal_id = $1::uuid`,
      [principal],
    );
    if ((r.rowCount ?? 0) === 0) throw new CalendarLinkNotFoundError();
    await this.d.audit.record(tx, {
      requestId: meta.requestId,
      action: 'update',
      resourceType: 'calendar_sync.calendar_link',
      resourceId: principal,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: { unlinked: true },
    });
    await this.d.queue.enqueue(
      tx,
      'calendar_sync.unlink_cleanup',
      { clinicianId: principal },
      { jobKey: `unlink_${principal}` },
    );
  }
}
