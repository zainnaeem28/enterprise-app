'use client';

import type { ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';

export const SIGN_IN_FAILED_MESSAGE =
  'We could not sign you in. Check that you used your work Google account and that you have been added to the marketing group, then try again. If it keeps happening, ask your administrator.';

// Pure view, so the error state can be rendered and tested without a router. The message is deliberately generic: it
// never says whether the account, the domain or the allow-list caused the denial.
export function SignInView({ failed }: { failed: boolean }): ReactElement {
  return (
    <div className="ehr-signin">
      <h2 className="ehr-signin__title">Sign in to edit the website</h2>
      {failed ? (
        <p className="ehr-signin__error" role="alert">
          {SIGN_IN_FAILED_MESSAGE}
        </p>
      ) : null}
      <p className="ehr-signin__help">
        Use your work Google account. Access is limited to the marketing team. If you cannot get in,
        ask your administrator to add you to the marketing group.
      </p>
      <a className="ehr-signin__button" href="/api/users/oauth/google/start">
        Sign in with Google
      </a>
    </div>
  );
}

// Shown above the (hidden) password form. Local password sign-in is disabled; the only way in is the marketing Google
// Workspace client. A plain link, not a script, so it works without client JavaScript and is keyboard reachable.
export function SignIn(): ReactElement {
  const failed = useSearchParams().get('error') === 'sign_in_failed';
  return <SignInView failed={failed} />;
}
