// Browser harness for the admin-config feature. StaffApp does not route /admin yet (outside this ticket's allowed paths), so this
// page mounts the real portal inside the real ElevationProvider and AdminRealmBar with the real shell runtime. The API is mocked per
// test by Playwright; the security key is a scripted stand-in (no physical key runs: Pending-human).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { SkipLink } from '@ehr/ui';
import { createShellRuntime } from '@ehr/app-shell';
import {
  AdminRealmBar,
  ElevationProvider,
  ElevationStore,
  createElevation,
} from '../../../admin-auth/index.js';
import type { SecurityKey } from '../../../admin-auth/index.js';
import { AdminConfigPortal, isAdminConfigPath } from '../../index.js';
import type { AdminConfigPath } from '../../index.js';

const key: SecurityKey = {
  async get() {
    return {
      kind: 'ok',
      assertion: {
        id: 'AQID',
        rawId: 'AQID',
        type: 'public-key',
        response: { clientDataJSON: 'AQID', authenticatorData: 'AQID', signature: 'AQID' },
      },
    };
  },
};
const runtime = createShellRuntime({ clientRelease: 'r1.000000000000' });
const store = new ElevationStore();
const elevation = createElevation(runtime, key, store);

function Root() {
  const [path, setPath] = useState<AdminConfigPath>(
    isAdminConfigPath(window.location.pathname) ? window.location.pathname : '/admin/clinics',
  );
  return (
    <ElevationProvider elevation={elevation}>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <AdminRealmBar
        runtime={runtime}
        elevation={store}
        productName="Clinic"
        displayName="Admin One"
      />
      <main id="main" className="ehr-main" tabIndex={-1}>
        <AdminConfigPortal
          runtime={runtime}
          path={path}
          navigate={(p) => {
            if (isAdminConfigPath(p)) {
              window.history.pushState(null, '', p);
              setPath(p);
            }
          }}
        />
      </main>
    </ElevationProvider>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
