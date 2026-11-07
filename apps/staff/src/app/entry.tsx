// Browser entry for the staff portal shell. `index.html` and `main.tsx` are outside this ticket's allowed paths; the
// Orchestrator is asked to point `main.tsx` at this file (see the submission comment).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { StaffApp } from './StaffApp.js';
import { createStaffRuntime } from './runtime.js';

const runtime = createStaffRuntime(__CLIENT_RELEASE__);
const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <StaffApp runtime={runtime} />
  </StrictMode>,
);
