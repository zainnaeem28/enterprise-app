// Browser harness for the documents feature only: the staff app's routing and session wiring are outside this ticket's
// allowed paths, so this page mounts `DocumentsPage` with the real shell runtime and the portal's shared styles.
// The API and the object store are mocked per test by Playwright (contract mock).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createRuntime } from '../../../../runtime.js';
import { DocumentsPage } from '../../DocumentsPage.js';

const runtime = createRuntime('r1.000000000000');
const permissions = (new URLSearchParams(window.location.search).get('perms') ?? '')
  .split(',')
  .filter(Boolean);

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <SkipLink targetId="main">Skip to main content</SkipLink>
    <header className="ehr-appbar">
      <p className="ehr-appbar__name">Staff portal</p>
    </header>
    <main id="main" className="ehr-main" tabIndex={-1}>
      <h1>Patient documents</h1>
      <DocumentsPage
        runtime={runtime}
        patientId="22222222-2222-4222-8222-222222222222"
        permissions={permissions}
      />
    </main>
  </StrictMode>,
);
