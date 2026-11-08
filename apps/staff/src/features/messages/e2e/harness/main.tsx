// Browser harness for the tasks and messages screens only: the staff app's routing and navigation are outside this ticket's allowed
// paths, so this page mounts `MessagesPortal` with the real shell runtime and the shared styles. The API is mocked per test by
// Playwright (contract mock of messaging.yaml with the BE-19 response shapes).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createRuntime } from '../../../../runtime.js';
import { MessagesPortal } from '../../index.js';

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
      <MessagesPortal runtime={runtime} />
    </main>
  </StrictMode>,
);
