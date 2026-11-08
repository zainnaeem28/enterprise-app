// Browser harness for the pre-consultation desk only: the staff app's routing and session wiring are outside this ticket's allowed
// paths, so this page mounts `PreconsultDesk` with the real shell runtime and the portal's shared styles. The API is mocked per test
// by Playwright (contract mock). `?path=` picks the screen; `?visit=1` selects a checked-in visit as the arrivals board would.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createRuntime } from '../../../../runtime.js';
import { PreconsultDesk, isPreconsultPath } from '../../index.js';
import type { PreconsultPath } from '../../index.js';
import { selection } from '../../DeskContext.js';

const runtime = createRuntime('r1.000000000000');
const params = new URLSearchParams(window.location.search);
const first = params.get('path') ?? '/arrivals';

if (params.get('visit') === '1')
  selection.set({
    reservationId: '44444444-4444-4444-8444-444444444444',
    patientId: '22222222-2222-4222-8222-222222222222',
    patientName: 'Amira Okafor',
    mrn: 'MRN-0000123',
    serviceId: 's',
    clinicianId: 'c',
    mode: 'in_person',
    status: 'checked_in',
    startsAt: new Date().toISOString(),
    endsAt: new Date().toISOString(),
    checkedInAt: new Date().toISOString(),
    method: 'desk',
    queueStage: 'waiting',
    previsit: { questionnaire: true, consents: false, insurance: true },
    noShowCandidate: false,
    flaggedForStaff: false,
    version: 4,
  });

function Page() {
  const [path, setPath] = useState<PreconsultPath>(isPreconsultPath(first) ? first : '/arrivals');
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">Staff portal</p>
      </header>
      <main id="main" className="ehr-main" tabIndex={-1}>
        <PreconsultDesk
          runtime={runtime}
          path={path}
          navigate={(p) => isPreconsultPath(p) && setPath(p)}
        />
      </main>
    </>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
