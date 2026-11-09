import { useEffect, useRef, useState } from 'react';
import { Banner, Button, TextField } from '@ehr/ui';
import type { ShellRuntime } from '@ehr/app-shell';
import { HANDLE_PATTERN, adminSignIn, normaliseHandle } from './api.js';
import type { Failure } from './api.js';
import { adminAuthStrings as s } from './strings.js';
import { browserSecurityKey } from './webauthn.js';
import type { SecurityKey } from './webauthn.js';
import './admin-auth.css';

/** Where the administrator lands after signing in: the admin portal's own landing screen (a path, never an identifier). */
export const ADMIN_LANDING = '/admin';
export const ADMIN_SIGN_IN_PATH = '/admin/sign-in';

/**
 * SH-04 Administrator sign-in (UI-UX 3.1, 4). A handle and a security key; there is no password, no Google button and no recovery
 * link. Every refusal reads the same ("handle or key not accepted"): the server answers one code for all of them and this page does
 * not tell them apart (ARCH 26.1). Success reloads into the admin landing screen so the CSRF token and the idle clock are loaded
 * fresh from `GET /auth/session`.
 */
export function AdminSignInPage({
  runtime,
  securityKey = browserSecurityKey,
  assign = (u) => window.location.assign(u),
  landing = ADMIN_LANDING,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  securityKey?: SecurityKey;
  assign?: (url: string) => void;
  landing?: string;
}) {
  const [handle, setHandle] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [waiting, setWaiting] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, []);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (waiting) return;
    const h = normaliseHandle(handle);
    if (h === '') return setFieldError(s.handleRequired);
    if (!HANDLE_PATTERN.test(h)) return setFieldError(s.handleFormat);
    setFieldError(undefined);
    setFailure(undefined);
    setWaiting(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const result = await adminSignIn(runtime.api, securityKey, h, ctl.signal);
    if (!live.current) return;
    if (result.ok) return assign(landing);
    setWaiting(false);
    setFailure(result);
  }

  return (
    <section aria-labelledby="admin-signin-title" className="ehr-auth">
      <h1 id="admin-signin-title">{s.signInTitle}</h1>
      <p>{s.signInLead}</p>
      {failure !== undefined && <FailureBanner failure={failure} />}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          label={s.handleLabel}
          hint={s.handleHint}
          {...(fieldError === undefined ? {} : { error: fieldError })}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          autoComplete="username webauthn"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <p role="status" className="ehr-hint">
          {waiting ? `${s.waitingTitle}. ${s.waitingBody}` : ''}
        </p>
        <Button type="submit" variant="primary" aria-disabled={waiting}>
          {s.useKey}
        </Button>
      </form>
      <p>
        <a href="/sign-in">{s.staffLink}</a>
      </p>
    </section>
  );
}

function FailureBanner({ failure }: { failure: Failure }) {
  switch (failure.reason) {
    case 'cancelled':
      return (
        <Banner tone="warning">
          <p>{s.cancelled}</p>
        </Banner>
      );
    case 'unsupported':
      return (
        <Banner tone="warning" title={s.unsupportedTitle}>
          <p>{s.unsupportedBody}</p>
        </Banner>
      );
    case 'unavailable':
      return (
        <Banner tone="warning" title={s.unavailableTitle}>
          <p>{s.unavailableBody}</p>
        </Banner>
      );
    case 'rate_limited':
      return (
        <Banner tone="warning" title={s.rateLimitedTitle}>
          <p>{s.rateLimitedBody(failure.retryAfterSeconds)}</p>
        </Banner>
      );
    case 'rejected':
      return (
        <Banner tone="danger" title={s.failedTitle}>
          <p>{s.failedBody}</p>
        </Banner>
      );
  }
}
