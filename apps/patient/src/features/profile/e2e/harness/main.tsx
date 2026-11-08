// Browser harness for the profile, privacy and messages features only. The app's own routing and shell wiring live outside this
// ticket's allowed paths (see README, "Mounting"), so this page mounts the three route sets the way the app will: real shell
// runtime, real history routing, the portal's shared styles. The API is mocked per test by Playwright (contract mock).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createPatientRuntime } from '../../../../app/runtime.js';
import { useLocation } from '../../../../app/router.js';
import { isMessagesPath, MessagesRoutes } from '../../../messages/index.js';
import { isPrivacyPath, PrivacyRoutes } from '../../../privacy/index.js';
import { isProfilePath, ProfileRoutes } from '../../index.js';

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
        {isProfilePath(location.path) && (
          <ProfileRoutes runtime={runtime} path={location.path} go={go} />
        )}
        {isPrivacyPath(location.path) && <PrivacyRoutes runtime={runtime} path={location.path} />}
        {isMessagesPath(location.path) && (
          <MessagesRoutes runtime={runtime} path={location.path} go={go} />
        )}
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
