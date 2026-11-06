import { AppBar, Button } from '@ehr/ui';
import type { ReactNode } from 'react';
import type { SessionStore } from '../session/session-store.js';
import { sessionStrings as s } from '../session/strings.js';
import type { RealmKind } from './realm.js';

const portalName: Record<RealmKind, string> = {
  staff: s.staffPortal,
  admin: s.adminPortal,
  patient: s.patientPortal,
  partner: s.partnerPortal,
  unknown: s.neutralPortal,
};

/**
 * App bar that names the realm in words (colour is never the only cue). The admin realm always shows the
 * fixed banner. Staff and admin cannot be held together, so the switch is a sign-out (UI-UX 3.1).
 */
export function RealmBar({
  realm,
  productName,
  displayName,
  store,
  children,
}: {
  realm: RealmKind;
  productName: string;
  displayName?: string;
  store: SessionStore;
  children?: ReactNode;
}) {
  const switchLabel =
    realm === 'staff' ? s.switchToAdmin : realm === 'admin' ? s.switchToStaff : undefined;
  return (
    <AppBar
      portalName={portalName[realm]}
      productName={productName}
      {...(realm === 'admin' ? { realmBanner: s.adminBanner } : {})}
      user={
        <div>
          {displayName !== undefined && <span>{displayName} </span>}
          <Button onClick={() => void store.signOut()}>{switchLabel ?? s.signOut}</Button>
          {switchLabel !== undefined && <p className="ehr-hint">{s.switchDraftNote}</p>}
        </div>
      }
    >
      {children}
    </AppBar>
  );
}
