import { adminAuthStrings as s } from './strings.js';
import { ADMIN_SIGN_IN_PATH } from './AdminSignInPage.js';

/** The separate "Administrator sign-in" link below the Google button on the staff sign-in page (UI-UX 3.1). */
export function AdminSignInLink() {
  return (
    <p className="ehr-muted">
      <a href={ADMIN_SIGN_IN_PATH}>{s.adminLink}</a>. {s.adminLinkHint}
    </p>
  );
}
