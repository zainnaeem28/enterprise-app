// Browser harness for the availability screens only: the staff app's routing and navigation are outside this ticket's allowed paths, so
// this page mounts `AvailabilityPortal` with the real shell runtime and the shared styles. The API is mocked per test by Playwright
// (contract mock). `?calendar=` is passed on as the return address of the Google callback would.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createRuntime } from '../../../../runtime.js';
import { AvailabilityPortal } from '../../index.js';

const runtime = createRuntime('r1.000000000000');

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <SkipLink targetId="main">Skip to main content</SkipLink>
    <header className="ehr-appbar">
      <p className="ehr-appbar__name">Staff portal</p>
    </header>
    <main id="main" className="ehr-main" tabIndex={-1}>
      <AvailabilityPortal
        runtime={runtime}
        search={window.location.search}
        // A stand-in for the browser leaving for Google: the page records where it would go.
        go={(url) => {
          document.body.dataset['wentTo'] = url;
        }}
      />
    </main>
  </StrictMode>,
);
