import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { App } from './app/App.js';
import { createPatientRuntime } from './app/runtime.js';

const runtime = createPatientRuntime({
  clientRelease: __CLIENT_RELEASE__,
  navigate: (to) => window.location.assign(to),
});
const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
