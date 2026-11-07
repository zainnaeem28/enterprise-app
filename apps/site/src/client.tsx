import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import './site.css';
import { TEMPLATES } from './analytics.js';
import type { Template } from './analytics.js';
import { ConsentBanner } from './components/ConsentBanner.js';
import { createConsent } from './consent.js';
import type { Choice } from './consent.js';

const body = document.body;
const t = body.dataset['template'] ?? 'not-found';
const template: Template = (TEMPLATES as readonly string[]).includes(t)
  ? (t as Template)
  : 'not-found';
const src = body.dataset['analyticsSrc'] ?? '';

const consent = createConsent({
  document,
  analyticsSrc: src === '' ? null : src,
  template,
  secure: location.protocol === 'https:',
});
consent.start();

// "Book" clicks are counted by template only; the link itself already carries only opaque IDs.
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('[data-book]') !== null)
    consent.track({ event: 'book_click', template });
});

function Island() {
  const [choice, setChoice] = useState<Choice | null>(consent.current());
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    const open = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('[data-cookie-settings]') !== null)
        setReopened(true);
    };
    document.addEventListener('click', open);
    return () => document.removeEventListener('click', open);
  }, []);
  if (choice !== null && !reopened) return null;
  return (
    <ConsentBanner
      onChoose={(c) => {
        consent.choose(c);
        setChoice(c);
        setReopened(false);
      }}
    />
  );
}

const root = document.getElementById('consent-root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <Island />
    </StrictMode>,
  );
