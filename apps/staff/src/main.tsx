import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { App } from './App.js';
import { createRuntime } from './runtime.js';

const runtime = createRuntime(__CLIENT_RELEASE__);
const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
