import { useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { createProfileApi } from './api.js';
import { AccountContext } from './lib/ctx.js';
import { useAccount } from './lib/hooks.js';
import { Problem } from './lib/Problem.js';
import { AcceptInvitePage } from './pages/AcceptInvitePage.js';
import { AddProxyPage } from './pages/AddProxyPage.js';
import { FamilyPage } from './pages/FamilyPage.js';
import { NotificationsPage } from './pages/NotificationsPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { matchProfileRoute } from './routes.js';
import './profile.css';

/**
 * Profile and contact details (PP-35), notification preferences (PP-36) and family and proxy access (PP-06..09).
 * Mounted by the app for the paths of `isProfilePath`.
 */
export function ProfileRoutes({
  runtime,
  path,
  go,
  activeId: controlled,
  onActiveChange,
}: {
  runtime: PatientRuntime;
  path: string;
  go: (to: string) => void;
  /** Who the portal acts for (PP-09). Pass both props to share the choice with the booking screens; otherwise it is kept here. */
  activeId?: string;
  onActiveChange?: (id: string) => void;
}) {
  const api = useMemo(() => createProfileApi(runtime), [runtime]);
  const [attempt, setAttempt] = useState(0);
  const { account, failure } = useAccount(runtime, attempt);
  const [own, setOwn] = useState<string | undefined>();
  const route = matchProfileRoute(path);

  if (route === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  if (failure !== undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (account === undefined) return <LoadingState label="Loading" lines={3} />;

  const activeId = controlled ?? own ?? account.selfId ?? account.people[0]?.patientId;
  const value = {
    api,
    go,
    people: account.people,
    selfId: account.selfId,
    activeId,
    setActiveId: (id: string) => {
      setOwn(id);
      onActiveChange?.(id);
    },
  };
  return (
    <AccountContext.Provider value={value}>
      {route.name === 'profile' && <ProfilePage />}
      {route.name === 'notifications' && <NotificationsPage />}
      {route.name === 'family' && <FamilyPage />}
      {route.name === 'family-add' && <AddProxyPage />}
      {route.name === 'family-accept' && <AcceptInvitePage grantId={route.grantId} />}
    </AccountContext.Provider>
  );
}
