import { Suspense, lazy, useEffect, useMemo } from 'react';
import { LoadingState, Banner, SkipLink } from '@ehr/ui';
import {
  NotFoundPage,
  RealmBar,
  ReleasePrompts,
  ServerErrorPage,
  SessionPrompts,
  realmKind,
} from '@ehr/app-shell';
import type { ShellRuntime } from '@ehr/app-shell';
import type { SecurityKey } from '../features/admin-auth/index.js';
import {
  NavBar,
  SignInPage,
  SignedOutPage,
  authStrings as s,
  navigationFor,
  safeReturnTo,
  useStaffSession,
} from '../features/auth/index.js';
import { isDoctorPath } from '../features/doctor/paths.js';
import { isPreconsultPath } from '../features/preconsult/paths.js';
import { isMessagesPath } from '../features/messages/paths.js';
import { isAvailabilityPath } from '../features/availability/paths.js';
import { ADMIN_COMPLIANCE_NAV, isAdminCompliancePath } from '../features/admin-compliance/paths.js';
import { ADMIN_CONFIG_NAV, isAdminConfigPath } from '../features/admin-config/paths.js';
import {
  ADMIN_LANDING,
  ADMIN_SIGN_IN_PATH,
  AdminRealmBar,
  AdminSignInLink,
  AdminSignInPage,
  ElevationProvider,
  ElevationStore,
  browserSecurityKey,
  createElevation,
} from '../features/admin-auth/index.js';
import { workspace } from '../features/doctor/workspace.js';
import { useLocation } from './router.js';

// Each portal is its own chunk, fetched on first visit to one of its screens, so the shell stays under the bundle budget.
const DoctorPortal = lazy(() =>
  import('../features/doctor/index.js').then((m) => ({ default: m.DoctorPortal })),
);
const PreconsultDesk = lazy(() =>
  import('../features/preconsult/index.js').then((m) => ({ default: m.PreconsultDesk })),
);
const MessagesPortal = lazy(() =>
  import('../features/messages/index.js').then((m) => ({ default: m.MessagesPortal })),
);
const AvailabilityPortal = lazy(() =>
  import('../features/availability/index.js').then((m) => ({ default: m.AvailabilityPortal })),
);
const DocumentsPage = lazy(() =>
  import('../features/documents/index.js').then((m) => ({ default: m.DocumentsPage })),
);
const AdminCompliancePortal = lazy(() =>
  import('../features/admin-compliance/index.js').then((m) => ({
    default: m.AdminCompliancePortal,
  })),
);
const AdminConfigPortal = lazy(() =>
  import('../features/admin-config/index.js').then((m) => ({ default: m.AdminConfigPortal })),
);

const PRODUCT = 'Clinic';

/** Where the administrator realm opens: the first compliance screen (the path is also the target of the post-sign-in reload). */
const ADMIN_HOME = ADMIN_COMPLIANCE_NAV[0]?.path ?? '/admin/audit';
/** The two admin areas, each opening on its first screen; the area's own sub-navigation lists the rest. */
const ADMIN_AREAS = [
  { id: 'compliance', label: 'Audit & compliance', path: ADMIN_HOME },
  {
    id: 'configuration',
    label: 'Configuration',
    path: ADMIN_CONFIG_NAV[0]?.path ?? '/admin/clinics',
  },
];
const isAdminPath = (path: string) =>
  path === ADMIN_LANDING || isAdminCompliancePath(path) || isAdminConfigPath(path);

/** The same Help link, in the same place (end of the page), on every screen (UI-UX 3.2, WCAG 3.2.6). */
function HelpFooter() {
  return (
    <footer className="ehr-help">
      <a href="/help">{s.helpLink}</a>
    </footer>
  );
}

function HelpPage() {
  return (
    <section aria-labelledby="help-title" className="ehr-auth">
      <h1 id="help-title">{s.helpTitle}</h1>
      <p>{s.helpBody}</p>
    </section>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">{PRODUCT} staff portal</p>
      </header>
      <main id="main" className="ehr-main" tabIndex={-1}>
        {children}
      </main>
      <HelpFooter />
    </>
  );
}

/** Screens that other tickets deliver (FE-09, FE-10, ...) register here; until then the link leads to a plain notice. */
function NotAvailable({ label }: { label: string }) {
  return (
    <section aria-labelledby="na-title">
      <h1 id="na-title">{label}</h1>
      <Banner tone="info">
        <p>{s.notAvailableBody}</p>
      </Banner>
    </section>
  );
}

export function StaffApp({
  runtime,
  assign = (u) => window.location.assign(u),
  securityKey = browserSecurityKey,
}: {
  runtime: ShellRuntime;
  assign?: (url: string) => void;
  securityKey?: SecurityKey;
}) {
  const loc = useLocation();

  if (loc.path === '/signed-out')
    return (
      <PublicShell>
        <SignedOutPage />
      </PublicShell>
    );
  if (loc.path === '/help')
    return (
      <PublicShell>
        <HelpPage />
      </PublicShell>
    );
  if (loc.path === ADMIN_SIGN_IN_PATH)
    return (
      <PublicShell>
        <AdminSignInPage
          runtime={runtime}
          securityKey={securityKey}
          assign={assign}
          landing={ADMIN_HOME}
        />
      </PublicShell>
    );
  if (loc.path === '/sign-in') {
    const params = new URLSearchParams(loc.search);
    return (
      <PublicShell>
        <SignInPage
          returnTo={safeReturnTo(params.get('returnTo'))}
          problem={params.has('problem')}
          belowGoogle={<AdminSignInLink />}
        />
      </PublicShell>
    );
  }
  return (
    <Gate
      runtime={runtime}
      path={loc.path}
      navigate={loc.navigate}
      assign={assign}
      securityKey={securityKey}
    />
  );
}

function Gate({
  runtime,
  path,
  navigate,
  assign,
  securityKey,
}: {
  runtime: ShellRuntime;
  path: string;
  navigate: (p: string, replace?: boolean) => void;
  assign: (u: string) => void;
  securityKey: SecurityKey;
}) {
  const { state, reload } = useStaffSession(runtime);
  // One elevation store per tab, in memory only; the administrator realm and the staff realm are never held together.
  const elevationStore = useMemo(() => new ElevationStore(), []);
  const elevation = useMemo(
    () => createElevation(runtime, securityKey, elevationStore),
    [runtime, securityKey, elevationStore],
  );
  const signInUrl = (p: string) => {
    if (isAdminPath(p)) return ADMIN_SIGN_IN_PATH;
    const back = safeReturnTo(p);
    return back === undefined ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(back)}`;
  };
  useEffect(() => runtime.releases.start(), [runtime]);

  // Not signed in: go to sign-in, remembering only a known screen path (never a query or an identifier).
  useEffect(() => {
    if (state.kind !== 'signed-out') return;
    assign(signInUrl(path));
  }, [state.kind, path, assign]);

  if (state.kind === 'loading' || state.kind === 'signed-out')
    return (
      <PublicShell>
        <LoadingState label={s.loadingSession} />
      </PublicShell>
    );
  if (state.kind === 'error')
    return (
      <PublicShell>
        <ServerErrorPage onRetry={reload} />
      </PublicShell>
    );

  const { session } = state;
  const realm = realmKind(session);
  const items = realm === 'staff' ? navigationFor(session.roleKeys) : [];
  const first = items.find((i) => i.id === 'schedule') ?? items[0];
  const firstItem = items[0];
  const current = items.find((i) => i.path === path);

  if (realm === 'admin')
    return (
      <ElevationProvider elevation={elevation}>
        <SkipLink targetId="main">Skip to main content</SkipLink>
        <AdminRealmBar
          runtime={runtime}
          elevation={elevationStore}
          productName={PRODUCT}
          displayName={session.displayName}
        />
        <ReleasePrompts store={runtime.releases} />
        <SessionPrompts store={runtime.session} onSignIn={() => assign(signInUrl(path))} />
        <NavBar
          items={ADMIN_AREAS}
          current={isAdminConfigPath(path) ? ADMIN_AREAS[1]!.path : ADMIN_AREAS[0]!.path}
          onNavigate={(p) => navigate(p)}
        />
        <main id="main" className="ehr-main" tabIndex={-1}>
          <Suspense fallback={<LoadingState label={s.loadingSession} />}>
            {path === ADMIN_LANDING || path === '/' ? (
              <Home first={ADMIN_HOME} navigate={navigate} />
            ) : isAdminCompliancePath(path) ? (
              <AdminCompliancePortal runtime={runtime} path={path} navigate={(p) => navigate(p)} />
            ) : isAdminConfigPath(path) ? (
              <AdminConfigPortal runtime={runtime} path={path} navigate={(p) => navigate(p)} />
            ) : (
              <NotFoundPage homeHref={ADMIN_HOME} />
            )}
          </Suspense>
        </main>
        <HelpFooter />
      </ElevationProvider>
    );

  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <RealmBar
        realm={realm}
        productName={PRODUCT}
        displayName={session.displayName}
        store={runtime.session}
      />
      <ReleasePrompts store={runtime.releases} />
      <SessionPrompts store={runtime.session} onSignIn={() => assign(signInUrl(path))} />
      <NavBar items={items} current={path} onNavigate={(p) => navigate(p)} />
      <main id="main" className="ehr-main" tabIndex={-1}>
        <Suspense fallback={<LoadingState label={s.loadingSession} />}>
          {realm !== 'staff' ? (
            <Banner tone="info">
              <p>{s.adminSession}</p>
            </Banner>
          ) : firstItem === undefined ? (
            <Banner tone="info">
              <p>{s.noNavigation}</p>
            </Banner>
          ) : path === '/' ? (
            <Home first={(first ?? firstItem).path} navigate={navigate} />
          ) : current !== undefined && isMessagesPath(path) ? (
            <MessagesPortal runtime={runtime} />
          ) : current !== undefined && isAvailabilityPath(path) ? (
            <AvailabilityPortal runtime={runtime} />
          ) : current !== undefined && isPreconsultPath(path) ? (
            <PreconsultDesk
              runtime={runtime}
              path={path}
              navigate={(p) => navigate(p)}
              openChart={(patientId) => {
                workspace.set({ patientId, label: 'Patient' });
                navigate('/patients');
              }}
            />
          ) : current !== undefined && isDoctorPath(path) ? (
            <DoctorPortal
              runtime={runtime}
              path={path}
              navigate={(p) => navigate(p)}
              renderDocuments={(patientId, permissions) => (
                <DocumentsPage runtime={runtime} patientId={patientId} permissions={permissions} />
              )}
            />
          ) : current !== undefined ? (
            <NotAvailable label={current.label} />
          ) : (
            <NotFoundPage homeHref={first?.path ?? '/'} />
          )}
        </Suspense>
      </main>
      <HelpFooter />
    </>
  );
}

function Home({
  first,
  navigate,
}: {
  first: string;
  navigate: (p: string, replace?: boolean) => void;
}) {
  useEffect(() => navigate(first, true), [first, navigate]);
  return null;
}
