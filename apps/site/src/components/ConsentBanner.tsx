import { useEffect, useRef } from 'react';
import type { Choice } from '../consent.js';

/** "Essential only" and "Accept all" are the same size and weight (BR-36). Not a modal: the page stays usable behind it. */
export function ConsentBanner({ onChoose }: { onChoose: (c: Choice) => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Move focus only when the visitor re-opened the banner themselves; the first visit leaves focus where it is.
    if (document.activeElement?.hasAttribute('data-cookie-settings') === true) ref.current?.focus();
  }, []);
  return (
    <section className="site-consent" aria-labelledby="consent-title">
      <h2 id="consent-title" tabIndex={-1} ref={ref}>
        Cookies
      </h2>
      <p>
        We use one essential cookie to remember this choice. With your permission we also use
        analytics to count which pages are visited. Analytics never receive health information,
        names or booking details.
      </p>
      <p>
        <a href="/legal/cookies">Read the cookie notice</a>
      </p>
      <div className="site-consent__actions">
        <button type="button" className="ehr-btn" onClick={() => onChoose('essential')}>
          Essential only
        </button>
        <button type="button" className="ehr-btn" onClick={() => onChoose('all')}>
          Accept all
        </button>
      </div>
    </section>
  );
}
