import { useEffect } from 'react';
import { PlaceholderMark, SkipLink } from '@ehr/ui';
import { ReleasePrompts } from '@ehr/app-shell';
import type { Runtime } from './runtime.js';
import { ConnectionPage } from './ConnectionPage.js';

export function App({ runtime }: { runtime: Runtime }) {
  useEffect(() => runtime.releases.start(), [runtime]);
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">Staff portal</p>
        <PlaceholderMark />
      </header>
      <ReleasePrompts store={runtime.releases} />
      <main id="main" className="ehr-main" tabIndex={-1}>
        <h1>Staff portal</h1>
        <ConnectionPage api={runtime.api} />
      </main>
    </>
  );
}
