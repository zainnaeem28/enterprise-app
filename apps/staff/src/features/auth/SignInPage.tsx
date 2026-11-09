import { Banner } from '@ehr/ui';
import { authStrings as s } from './strings.js';
import { googleSignInHref } from './return-to.js';

/**
 * SH-03 Staff sign-in. "Continue with Google" is the only way in; there is no password field (RA-R1-01). The server
 * answers every failed sign-in the same way, so this page cannot tell a non-enrolled account from any other failure:
 * the plain contact-IT sentence is always shown, and shown as a notice when the page is opened with `?problem`.
 */
export function SignInPage({
  returnTo,
  problem,
  belowGoogle,
}: {
  returnTo?: string | undefined;
  problem?: boolean;
  /** Rendered directly below the Google button (the app composes the separate administrator sign-in link here). */
  belowGoogle?: React.ReactNode;
}) {
  return (
    <section aria-labelledby="signin-title" className="ehr-auth">
      <h1 id="signin-title">{s.signInTitle}</h1>
      {problem === true && (
        <Banner tone="warning" title={s.problemTitle}>
          <p>{s.problemBody}</p>
        </Banner>
      )}
      <p>{s.signInLead}</p>
      <p>
        <a className="ehr-btn ehr-btn--primary" href={googleSignInHref(returnTo)}>
          {s.continueWithGoogle}
        </a>
      </p>
      {belowGoogle}
      <p className="ehr-muted" data-testid="not-enrolled">
        <strong>{s.notEnrolledTitle}.</strong> {s.notEnrolledBody}
      </p>
    </section>
  );
}
