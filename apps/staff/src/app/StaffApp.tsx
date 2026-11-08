import { useEffect } from 'react';
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
import {
  NavBar,
  SignInPage,
  SignedOutPage,
  authStrings as s,
  navigationFor,
  safeReturnTo,
  useStaffSession,
} from '../features/auth/index.js';
import { useLocation } from './router.js';

const PRODUCT = 'Clinic';

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
}: {
  runtime: ShellRuntime;
  assign?: (url: string) => void;
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
  if (loc.path === '/sign-in') {
    const params = new URLSearchParams(loc.search);
    return (
      <PublicShell>
        <SignInPage
          returnTo={safeReturnTo(params.get('returnTo'))}
          problem={params.has('problem')}
        />
      </PublicShell>
    );
  }
  return <Gate runtime={runtime} path={loc.path} navigate={loc.navigate} assign={assign} />;
}

function Gate({
  runtime,
  path,
  navigate,
  assign,
}: {
  runtime: ShellRuntime;
  path: string;
  navigate: (p: string, replace?: boolean) => void;
  assign: (u: string) => void;
}) {
  const { state, reload } = useStaffSession(runtime);
  useEffect(() => runtime.releases.start(), [runtime]);

  // Not signed in: go to sign-in, remembering only a known screen path (never a query or an identifier).
  useEffect(() => {
    if (state.kind !== 'signed-out') return;
    const back = safeReturnTo(path);
    assign(back === undefined ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(back)}`);
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
      <SessionPrompts
        store={runtime.session}
        onSignIn={() => {
          const back = safeReturnTo(path);
          assign(back === undefined ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(back)}`);
        }}
      />
      <NavBar items={items} current={path} onNavigate={(p) => navigate(p)} />
      <main id="main" className="ehr-main" tabIndex={-1}>
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
        ) : current !== undefined ? (
          <NotAvailable label={current.label} />
        ) : (
          <NotFoundPage homeHref={first?.path ?? '/'} />
        )}
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
