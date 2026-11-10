// Browser harness for the booking feature only. The app's own routing and shell wiring live outside this ticket's allowed
// paths (see README, "Mounting"), so this page mounts `BookingRoutes` the way the app will: real shell runtime, real
// history routing, the portal's shared styles. The API is mocked per test by Playwright (contract mock).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createPatientRuntime } from '../../../../app/runtime.js';
import { useLocation } from '../../../../app/router.js';
import { BookSignInPage } from '../../../auth/BookSignInPage.js';
import { BookingRoutes } from '../../index.js';

const runtime = createPatientRuntime({
  clientRelease: 'r1.000000000000',
  navigate: (to) => window.location.assign(to),
});

function Page() {
  const { location, go } = useLocation();
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">Patient portal</p>
      </header>
      <main id="main" className="ehr-main" tabIndex={-1}>
        <BookingRoutes
          runtime={runtime}
          path={location.path}
          params={location.params}
          go={go}
          signedOut={
            <BookSignInPage
              onContinue={(intent) =>
                go(
                  `/continue?intent=${intent}&returnTo=${encodeURIComponent(
                    window.location.pathname + window.location.search,
                  )}`,
                )
              }
            />
          }
        />
      </main>
    </>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
