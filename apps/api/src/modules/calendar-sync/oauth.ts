// The OAuth leg of the calendar link (ARCHITECTURE 25.9, 29.3: "OAuth with minimal scopes (events on one calendar, free/busy read)").
// `OAuthPort` is what the service needs; `GoogleCalendarOAuth` is the Google implementation over `fetch`.
// Hostnames are constants here (SEC01-F-12, INT-N7): never from a setting, never from a request. Tests hand the implementation a
// stub's URL through the constructor, which only code can do.
// A refresh token exists in this file only as the returned value of `exchangeCode`. It is never logged, and no error carries a
// response body (Google's error text can echo request fields).
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;

export interface OAuthPort {
  authorizationUrl(i: { state: string; codeChallenge: string; loginHint?: string }): string;
  /** The offline refresh token for an authorisation code. Throws `OAuthExchangeError` when none could be obtained. */
  exchangeCode(i: { code: string; codeVerifier: string }): Promise<{ refreshToken: string }>;
}

/** The exchange failed or returned no refresh token. Carries a class only, never a vendor message. */
export class OAuthExchangeError extends Error {
  constructor(readonly reason: 'rejected' | 'unavailable' | 'no_refresh_token') {
    super(reason);
    this.name = 'OAuthExchangeError';
  }
}

export interface GoogleOAuthOptions {
  clientId: string;
  /** An application secret of the API task (it is not a `secret_ref`: BD-11 makes outbound references write-only for the API). */
  clientSecret: string;
  redirectUri: string;
  authUrl?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GoogleCalendarOAuth implements OAuthPort {
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: GoogleOAuthOptions) {
    this.authUrl = o.authUrl ?? GOOGLE_AUTH_URL;
    this.tokenUrl = o.tokenUrl ?? GOOGLE_TOKEN_URL;
    this.doFetch = o.fetch ?? fetch;
  }

  authorizationUrl(i: { state: string; codeChallenge: string; loginHint?: string }): string {
    const u = new URL(this.authUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.o.clientId);
    u.searchParams.set('redirect_uri', this.o.redirectUri);
    u.searchParams.set('scope', CALENDAR_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'false');
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (i.loginHint !== undefined) u.searchParams.set('login_hint', i.loginHint);
    return u.toString();
  }

  async exchangeCode(i: { code: string; codeVerifier: string }): Promise<{ refreshToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: i.code,
      code_verifier: i.codeVerifier,
      client_id: this.o.clientId,
      client_secret: this.o.clientSecret,
      redirect_uri: this.o.redirectUri,
    });
    let res: Response;
    try {
      res = await this.doFetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch {
      throw new OAuthExchangeError('unavailable');
    }
    if (res.status >= 500 || res.status === 429) throw new OAuthExchangeError('unavailable');
    if (!res.ok) throw new OAuthExchangeError('rejected');
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new OAuthExchangeError('rejected');
    }
    const t = (json as { refresh_token?: unknown } | null)?.refresh_token;
    if (typeof t !== 'string' || t.length < 8 || t.length > 4096)
      throw new OAuthExchangeError('no_refresh_token');
    return { refreshToken: t };
  }
}
