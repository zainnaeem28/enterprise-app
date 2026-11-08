import { authStrings as s } from './strings.js';

/** SH-06 Signed out. Reached after "Sign out"; says what happened and offers the one way back in. */
export function SignedOutPage() {
  return (
    <section aria-labelledby="signedout-title" className="ehr-auth">
      <h1 id="signedout-title">{s.signedOutTitle}</h1>
      <p>{s.signedOutBody}</p>
      <p>
        <a className="ehr-btn ehr-btn--primary" href="/sign-in">
          {s.signedOutAction}
        </a>
      </p>
    </section>
  );
}
