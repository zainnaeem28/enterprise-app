import { useEffect, useState } from 'react';
import { BrandWordmark, resolveBrandName, SkipLink } from '@ehr/ui';
import { MaintenanceBanners, ReleasePrompts, SessionPrompts } from '@ehr/app-shell';
import type { PatientRuntime } from './runtime.js';
import { useLocation } from './router.js';
import { EntryPage } from '../features/auth/EntryPage.js';
import type { Intent } from '../features/auth/EntryPage.js';
import { PreRedirectPage } from '../features/auth/PreRedirectPage.js';
import { BookSignInPage } from '../features/auth/BookSignInPage.js';
import { LandingPage } from '../features/auth/LandingPage.js';
import { ProblemPage } from '../features/auth/ProblemPage.js';
import { isProblemCode } from '../features/auth/problems.js';
import type { Problem } from '../features/auth/problems.js';
import { checkedReturnTo, DEFAULT_RETURN_TO } from '../features/auth/returnTo.js';
import { BookingRoutes, isBookingPath } from '../features/booking/index.js';
import { isPrevisitPath, PrevisitRoutes } from '../features/previsit/index.js';
import { isTelehealthPath, TelehealthRoutes } from '../features/telehealth/index.js';
import { isProfilePath, ProfileRoutes } from '../features/profile/index.js';
import { isPrivacyPath, PrivacyRoutes } from '../features/privacy/index.js';
import { isMessagesPath, MessagesRoutes } from '../features/messages/index.js';
import { probeSignIn, signInUrl } from '../features/auth/signIn.js';

/** The path with its query, so a hand-off such as `/book?serviceId=…` survives sign-in. */
const fullPath = (l: { path: string; params: URLSearchParams }) => {
  const q = l.params.toString();
  return q === '' ? l.path : `${l.path}?${q}`;
};

export function App({
  runtime,
  assign = (url) => window.location.assign(url),
}: {
  runtime: PatientRuntime;
  /** Whole-page navigation to the API (injected in tests). */
  assign?: (url: string) => void;
}) {
  const { location, go } = useLocation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>();
  useEffect(() => runtime.releases.start(), [runtime]);
  const returnTo = checkedReturnTo(location.params.get('returnTo'));

  const toContinue = (intent: Intent, to = returnTo) =>
    go(`/continue?intent=${intent}&returnTo=${encodeURIComponent(to)}`);

  const start = async () => {
    setBusy(true);
    const result = await probeSignIn(runtime.api, returnTo);
    if (result.kind === 'redirect') return assign(signInUrl(returnTo));
    setBusy(false);
    setProblem(result.problem);
  };

  let page;
  if (problem !== undefined) {
    page = (
      <ProblemPage
        problem={problem}
        onRetry={() => {
          setProblem(undefined);
          void start();
        }}
        onSignIn={() => {
          setProblem(undefined);
          go('/');
        }}
      />
    );
  } else if (location.path === '/continue') {
    page = (
      <PreRedirectPage
        intent={location.params.get('intent') === 'create' ? 'create' : 'sign-in'}
        busy={busy}
        onContinue={() => void start()}
        onBack={() => go('/')}
      />
    );
  } else if (location.path === DEFAULT_RETURN_TO) {
    page = (
      <LandingPage
        runtime={runtime}
        onSignIn={() => toContinue('sign-in', DEFAULT_RETURN_TO)}
        go={go}
      />
    );
  } else if (isBookingPath(location.path)) {
    page = (
      <BookingRoutes
        runtime={runtime}
        path={location.path}
        params={location.params}
        go={go}
        signedOut={
          <BookSignInPage onContinue={(intent) => toContinue(intent, fullPath(location))} />
        }
      />
    );
  } else if (location.path === '/problem') {
    const code = location.params.get('code');
    page = (
      <ProblemPage
        problem={{ code: isProblemCode(code) ? code : 'identity.sign_in_failed' }}
        onSignIn={() => toContinue('sign-in')}
      />
    );
  } else if (isPrevisitPath(location.path)) {
    page = <PrevisitRoutes runtime={runtime} path={location.path} go={go} />;
  } else if (isTelehealthPath(location.path)) {
    page = <TelehealthRoutes runtime={runtime} path={location.path} />;
  } else if (isProfilePath(location.path)) {
    page = <ProfileRoutes runtime={runtime} path={location.path} go={go} />;
  } else if (isPrivacyPath(location.path)) {
    page = <PrivacyRoutes runtime={runtime} path={location.path} />;
  } else if (isMessagesPath(location.path)) {
    page = <MessagesRoutes runtime={runtime} path={location.path} go={go} />;
  } else {
    page = <EntryPage onContinue={(intent) => toContinue(intent, DEFAULT_RETURN_TO)} />;
  }

  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">Patient portal</p>
        <BrandWordmark
          name={resolveBrandName(import.meta.env.VITE_ORGANISATION_NAME, 'Patient portal')}
        />
      </header>
      <ReleasePrompts store={runtime.releases} />
      <MaintenanceBanners api={runtime.api} />
      <SessionPrompts
        store={runtime.session}
        onSignIn={() =>
          toContinue('sign-in', checkedReturnTo(window.location.pathname + window.location.search))
        }
      />
      <main id="main" className="ehr-main" tabIndex={-1}>
        {page}
      </main>
    </>
  );
}
