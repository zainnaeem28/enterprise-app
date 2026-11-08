// Browser harness for the doctor portal only: the staff app's routing and session wiring are outside this ticket's allowed paths, so this
// page mounts `DoctorPortal` with the real shell runtime and the portal's shared styles. The API is mocked per test by Playwright (contract
// mock). `?path=` picks the screen; `?open=1` opens the chart of a visit as the schedule would; `?video=1` adds a fake video adapter;
// `?stream=real` uses the browser's EventSource (the test then refuses it); `?cosign=1` puts a note that waits for co-signature into this session.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SkipLink } from '@ehr/ui';
import '@ehr/ui/styles.css';
import { createRuntime } from '../../../../runtime.js';
import { DoctorPortal, isDoctorPath } from '../../index.js';
import type { DoctorPath, VideoAdapter } from '../../index.js';
import { FakeStream } from '../../fake-stream.js';
import { noteStore, workspace } from '../../workspace.js';

const runtime = createRuntime('r1.000000000000');
const params = new URLSearchParams(window.location.search);
const first = params.get('path') ?? '/schedule';

const visit = {
  reservationId: '44444444-4444-4444-8444-444444444444',
  patientId: '22222222-2222-4222-8222-222222222222',
  patientName: 'Amira Okafor',
  mrn: 'MRN-0000123',
  clinicianId: '88888888-8888-4888-8888-888888888888',
  mode: params.get('video') === '1' ? ('video' as const) : ('in_person' as const),
  status: 'checked_in',
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  queueStage: 'ready',
};
if (params.get('open') === '1')
  workspace.set({ patientId: visit.patientId, label: 'Amira Okafor', visit });
if (params.get('cosign') === '1')
  noteStore.put({
    note: {
      id: '77777777-7777-4777-8777-777777777777',
      encounterId: '66666666-6666-4666-8666-666666666666',
      patientId: visit.patientId,
      status: 'pending_cosign',
      sections: {
        subjective: 'Cough for three days',
        objective: 'Chest clear',
        assessment: 'Viral',
        plan: 'Fluids',
      },
      cosignRequiredFrom: 'sup',
      signedAt: null,
      cosignedAt: null,
      version: 3,
      banner: null,
    },
    patientName: 'Amira Okafor',
    dateOfBirth: '1984-03-27',
  });

// A stand-in for the vendor SDK: draws a labelled box. The real adapter is added by the video-vendor ticket.
const video: VideoAdapter = {
  join: (el) => {
    el.textContent = 'Video call (stand-in adapter)';
    el.style.display = 'grid';
    el.style.placeItems = 'center';
    return Promise.resolve({
      leave: () => {
        el.textContent = '';
        return Promise.resolve();
      },
    });
  },
};

// A connected stream for every screen except the one that checks the real refusal (`?stream=real`).
function connected() {
  const s = new FakeStream();
  queueMicrotask(() => s.open());
  return s;
}

function Page() {
  const [path, setPath] = useState<DoctorPath>(isDoctorPath(first) ? first : '/schedule');
  return (
    <>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <header className="ehr-appbar">
        <p className="ehr-appbar__name">Staff portal</p>
      </header>
      <main id="main" className="ehr-main" tabIndex={-1}>
        <DoctorPortal
          runtime={runtime}
          path={path}
          navigate={(p) => isDoctorPath(p) && setPath(p)}
          {...(params.get('video') === '1' ? { video } : {})}
          {...(params.get('stream') === 'real' ? {} : { stream: () => connected() })}
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
