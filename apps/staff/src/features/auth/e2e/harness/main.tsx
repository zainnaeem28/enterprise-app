// Browser harness: the real StaffApp and shell runtime, served from a Vite root of its own because `index.html` and
// `main.tsx` of the app are outside this ticket's allowed paths. The API is mocked per test by Playwright.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { StaffApp } from '../../../../app/StaffApp.js';
import { createStaffRuntime } from '../../../../app/runtime.js';

const runtime = createStaffRuntime('r1.000000000000');
const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <StaffApp runtime={runtime} />
  </StrictMode>,
);
