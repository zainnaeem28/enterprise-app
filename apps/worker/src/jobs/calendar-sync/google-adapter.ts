// The Google Calendar adapter (kind `google_calendar`, ARCHITECTURE 22.3, 33.1, 34.3). It owns no log, retry or circuit: `callVendor`
// wraps every call (integration-core). Operations are the contract's list: push_busy, delete_busy, incremental_sync, watch, stop_watch.
//
// * Hostnames are constants (SEC01-F-12, INT-N7): never from a setting or an argument. The constructor can point tests at a stub.
// * Credentials: the doctor's refresh token is read through `CredentialReader` under `cal-<clinician id>` and exchanged for a short-lived
//   access token that lives in memory only (never logged or returned); the OAuth client ID is a non-secret connection setting
//   (`settings.clientId`) and the client secret is the outbound secret `oauth-client-secret` of the connection.
// * Busy events are written with the title "Busy" and nothing else (BR-07): no description, attendee, location or reference to the
//   patient, the reason or the service. The event ID is derived from the occupancy ID, so a retry cannot create a duplicate (34.3).
// * Listing asks Google for no title, description, attendee name or location (a `fields` mask) and reduces each event to an ID and an
//   interval before anything is returned (busy.ts).
// * An error never carries a response body: Google's text can echo request fields.
import {
  type CredentialReader,
  type HealthResult,
  type OperationOf,
  type VendorAdapter,
  type VendorCall,
  type VendorResult,
} from '../integration-core/adapters.js';
import { AdapterFailure } from '../integration-core/errors.js';
import { OWN_EVENT_KEY, toBusyChange, type GoogleEventLite } from './busy.js';
import { tokenSecretName } from './ids.js';

export const GOOGLE_API_BASE = 'https://www.googleapis.com';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const OAUTH_CLIENT_SECRET_NAME = 'oauth-client-secret';
export const BUSY_TITLE = 'Busy';

const EVENT_FIELDS =
  'nextPageToken,nextSyncToken,timeZone,items(id,status,transparency,start,end,extendedProperties/private,attendees(self,responseStatus))';
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

export interface GoogleAdapterOptions {
  apiBase?: string;
  tokenEndpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

class AccessToken {
  constructor(
    readonly value: string,
    readonly expiresAt: number,
  ) {}
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

const str = (a: Readonly<Record<string, unknown>>, k: string, max = 2048): string => {
  const v = a[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max)
    throw new AdapterFailure(false, undefined, 'bad_argument');
  return v;
};
const optStr = (a: Readonly<Record<string, unknown>>, k: string, max = 2048): string | undefined =>
  a[k] === undefined ? undefined : str(a, k, max);

function iso(a: Readonly<Record<string, unknown>>, k: string): string {
  const v = str(a, k, 40);
  if (Number.isNaN(Date.parse(v))) throw new AdapterFailure(false, undefined, 'bad_argument');
  return new Date(v).toISOString();
}

const retryableStatus = (s: number): boolean => s === 408 || s === 429 || s >= 500;

export class GoogleCalendarAdapter implements VendorAdapter<'google_calendar'> {
  readonly kind = 'google_calendar' as const;
  /** The deterministic event ID is our idempotency (a repeated insert answers 409 and is then made equal). */
  readonly supportsIdempotencyToken = true;
  readonly timeoutMs = 20_000;

  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly access = new Map<string, AccessToken>();

  constructor(o: GoogleAdapterOptions = {}) {
    this.api = o.apiBase ?? GOOGLE_API_BASE;
    this.tokenUrl = o.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  async call(req: VendorCall & { operation: OperationOf<'google_calendar'> }): Promise<VendorResult> {
    const a = req.args;
    switch (req.operation) {
      case 'push_busy':
        return this.pushBusy(req, a);
      case 'delete_busy':
        return this.deleteBusy(req, a);
      case 'incremental_sync':
        return this.list(req, a);
      case 'watch':
        return this.watch(req, a);
      case 'stop_watch':
        return this.stopWatch(req, a);
    }
  }

  async healthCheck(): Promise<HealthResult> {
    // No doctor is involved in a connection test: an unauthenticated read of the public discovery document proves the host answers.
    try {
      const res = await this.doFetch(`${this.api}/discovery/v1/apis/calendar/v3/rest?fields=id`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { ok: res.ok, httpStatus: res.status };
    } catch {
      return { ok: false };
    }
  }

  // ---- operations ---------------------------------------------------------------------------------------------------
  private eventsPath(a: Readonly<Record<string, unknown>>): string {
    return `/calendar/v3/calendars/${encodeURIComponent(str(a, 'calendarId', 256))}/events`;
  }

  private busyBody(a: Readonly<Record<string, unknown>>, eventId: string): Record<string, unknown> {
    return {
      id: eventId,
      summary: BUSY_TITLE,
      start: { dateTime: iso(a, 'startsAt') },
      end: { dateTime: iso(a, 'endsAt') },
      transparency: 'opaque',
      visibility: 'private',
      reminders: { useDefault: false },
      extendedProperties: { private: { [OWN_EVENT_KEY]: '1' } },
    };
  }

  private async pushBusy(req: VendorCall, a: Readonly<Record<string, unknown>>): Promise<VendorResult> {
    const eventId = str(a, 'eventId', 1024);
    if (!/^[a-v0-9]{5,1024}$/.test(eventId)) throw new AdapterFailure(false, undefined, 'bad_argument');
    const clinician = str(a, 'clinicianId', 64);
    const body = this.busyBody(a, eventId);
    const r = await this.send(req, clinician, 'POST', this.eventsPath(a), { body, ok: [409] });
    if (r.status === 409) {
      // The event exists already (a retry, or it was deleted and the ID is kept by Google): make it equal and confirmed.
      await this.send(req, clinician, 'PUT', `${this.eventsPath(a)}/${encodeURIComponent(eventId)}`, {
        body: { ...body, status: 'confirmed' },
      });
    }
    return { data: { eventId }, httpStatus: r.status, vendorRef: eventId };
  }

  private async deleteBusy(req: VendorCall, a: Readonly<Record<string, unknown>>): Promise<VendorResult> {
    const eventId = str(a, 'eventId', 1024);
    const r = await this.send(
      req,
      str(a, 'clinicianId', 64),
      'DELETE',
      `${this.eventsPath(a)}/${encodeURIComponent(eventId)}`,
      { ok: [404, 410] },
    );
    return { data: { eventId, alreadyGone: r.status !== 204 && r.status !== 200 }, httpStatus: r.status, vendorRef: eventId };
  }

  private async list(req: VendorCall, a: Readonly<Record<string, unknown>>): Promise<VendorResult> {
    const q = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: '250',
      fields: EVENT_FIELDS,
    });
    const syncToken = optStr(a, 'syncToken');
    if (syncToken !== undefined) q.set('syncToken', syncToken);
    else {
      q.set('timeMin', iso(a, 'timeMin'));
      q.set('timeMax', iso(a, 'timeMax'));
    }
    const pageToken = optStr(a, 'pageToken');
    if (pageToken !== undefined) q.set('pageToken', pageToken);
    const r = await this.send(req, str(a, 'clinicianId', 64), 'GET', `${this.eventsPath(a)}?${q.toString()}`);
    const j = r.json as {
      items?: GoogleEventLite[];
      nextPageToken?: string;
      nextSyncToken?: string;
      timeZone?: string;
    } | null;
    const changes = [];
    for (const e of Array.isArray(j?.items) ? j.items : []) {
      const c = toBusyChange(e, typeof j?.timeZone === 'string' ? j.timeZone : undefined);
      if (c !== undefined) changes.push(c);
    }
    return {
      data: {
        changes,
        ...(typeof j?.nextPageToken === 'string' ? { nextPageToken: j.nextPageToken } : {}),
        ...(typeof j?.nextSyncToken === 'string' ? { nextSyncToken: j.nextSyncToken } : {}),
      },
      httpStatus: r.status,
    };
  }

  private async watch(req: VendorCall, a: Readonly<Record<string, unknown>>): Promise<VendorResult> {
    const expiresAt = Number(a['expiresAtMs']);
    if (!Number.isFinite(expiresAt)) throw new AdapterFailure(false, undefined, 'bad_argument');
    const address = str(a, 'address', 1024);
    if (!address.startsWith('https://')) throw new AdapterFailure(false, undefined, 'bad_argument');
    const r = await this.send(req, str(a, 'clinicianId', 64), 'POST', `${this.eventsPath(a)}/watch`, {
      body: {
        id: str(a, 'channelId', 128),
        type: 'web_hook',
        address,
        token: str(a, 'token', 256),
        expiration: String(Math.floor(expiresAt)),
      },
    });
    const j = r.json as { resourceId?: unknown; expiration?: unknown } | null;
    if (typeof j?.resourceId !== 'string') throw new AdapterFailure(true, r.status, 'bad_response');
    const exp = Number(j.expiration);
    return {
      data: { resourceId: j.resourceId, ...(Number.isFinite(exp) ? { expiresAtMs: exp } : {}) },
      httpStatus: r.status,
    };
  }

  private async stopWatch(req: VendorCall, a: Readonly<Record<string, unknown>>): Promise<VendorResult> {
    const r = await this.send(req, str(a, 'clinicianId', 64), 'POST', '/calendar/v3/channels/stop', {
      body: { id: str(a, 'channelId', 128), resourceId: str(a, 'resourceId', 256) },
      ok: [404],
    });
    return { data: {}, httpStatus: r.status };
  }

  // ---- HTTP ---------------------------------------------------------------------------------------------------------
  private async send(
    req: VendorCall,
    clinician: string,
    method: string,
    path: string,
    o: { body?: unknown; ok?: readonly number[] } = {},
  ): Promise<{ status: number; json: unknown }> {
    let res: Response | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const token = await this.accessToken(req, clinician, pass > 0);
      try {
        res = await this.doFetch(`${this.api}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
          signal: req.signal,
        });
      } catch {
        throw new AdapterFailure(true, undefined, 'network');
      }
      if (res.status !== 401) break;
      this.access.delete(clinician); // an access token Google no longer accepts: refresh once, then it is a revoked grant
    }
    const r = res as Response;
    const text = r.status === 204 ? '' : await r.text().catch(() => '');
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (r.ok || (o.ok ?? []).includes(r.status)) return { status: r.status, json };
    throw this.failure(r.status, json);
  }

  private failure(status: number, json: unknown): AdapterFailure {
    if (status === 401) return new AdapterFailure(false, 401, 'token_revoked');
    if (status === 410) return new AdapterFailure(false, 410, 'gone');
    if (status === 403) {
      const reason = (json as { error?: { errors?: { reason?: unknown }[] } } | null)?.error?.errors?.[0]?.reason;
      return typeof reason === 'string' && RATE_REASONS.has(reason)
        ? new AdapterFailure(true, 403, 'rate_limited')
        : new AdapterFailure(false, 403, 'forbidden');
    }
    if (retryableStatus(status)) return new AdapterFailure(true, status, 'vendor_error');
    return new AdapterFailure(false, status, 'vendor_rejected');
  }

  private async accessToken(req: VendorCall, clinician: string, force: boolean): Promise<string> {
    const hit = this.access.get(clinician);
    if (!force && hit !== undefined && hit.expiresAt > this.now() + 60_000) return hit.value;
    const creds: CredentialReader = req.credentials;
    const clientId = req.connection.settings['clientId'];
    if (typeof clientId !== 'string' || clientId === '') throw new AdapterFailure(false, undefined, 'not_configured');
    const refresh = await creds.get(tokenSecretName(clinician));
    const clientSecret = await creds.get(OAUTH_CLIENT_SECRET_NAME);
    let res: Response;
    try {
      res = await this.doFetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: req.signal,
      });
    } catch {
      throw new AdapterFailure(true, undefined, 'network');
    }
    if (!res.ok) {
      if (retryableStatus(res.status)) throw new AdapterFailure(true, res.status, 'oauth_unavailable');
      // 400 invalid_grant: the doctor revoked the app or the token was disabled. Not retryable: the link is broken (TC-CAL-06).
      throw new AdapterFailure(false, 401, 'token_revoked');
    }
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof j?.access_token !== 'string') throw new AdapterFailure(true, res.status, 'bad_response');
    const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3000;
    this.access.set(clinician, new AccessToken(j.access_token, this.now() + ttl * 1000));
    return j.access_token;
  }
}
