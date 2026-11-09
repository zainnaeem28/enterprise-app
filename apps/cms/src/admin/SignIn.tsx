import type { ReactElement } from 'react';

// Shown above the (hidden) password form. Local password sign-in is disabled; the only way in is the marketing Google
// Workspace client. A plain link, not a script, so it works without client JavaScript and is keyboard reachable.
export function SignIn(): ReactElement {
  return (
    <div className="ehr-signin">
      <h2 className="ehr-signin__title">Sign in to edit the website</h2>
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
