// Browser harness for the admin-auth feature. The app's own StaffApp does not route /admin yet (outside this ticket's allowed
// paths), so this page mounts the real components with the real shell runtime. The API is mocked per test by Playwright; the
// security key is a scripted stand-in selected with ?key=ok|cancel (no physical key runs: Pending-human).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@ehr/ui/styles.css';
import { SkipLink } from '@ehr/ui';
import { createShellRuntime } from '@ehr/app-shell';
import {
  AdminRealmBar,
  AdminSignInLink,
  AdminSignInPage,
  ElevationProvider,
  ElevationStore,
  createElevation,
} from '../../index.js';
import type { SecurityKey } from '../../index.js';

const params = new URLSearchParams(window.location.search);
const mode = params.get('key') ?? 'ok';
const key: SecurityKey = {
  async get() {
    if (mode === 'cancel') return { kind: 'cancelled' };
    return {
      kind: 'ok',
      assertion: {
        id: 'AQID',
        rawId: 'AQID',
        type: 'public-key',
        response: { clientDataJSON: 'AQID', authenticatorData: 'AQID', signature: 'AQID' },
      },
    };
  },
};

const runtime = createShellRuntime({
  clientRelease: 'r1.000000000000',
  afterSignOut: () => {
    document.title = 'signed-out';
    document.body.dataset['signedOut'] = 'yes';
  },
});
const store = new ElevationStore();
const elevation = createElevation(runtime, key, store);

function Admin() {
  const [done, setDone] = useState<string>('');
  return (
    <ElevationProvider elevation={elevation}>
      <SkipLink targetId="main">Skip to main content</SkipLink>
      <AdminRealmBar
        runtime={runtime}
        elevation={store}
        productName="Clinic"
        displayName="Admin One"
      />
      <main id="main" className="ehr-main" tabIndex={-1}>
        <h1>Users and roles</h1>
        <ChangeRole onDone={setDone} />
        <p data-testid="result">{done}</p>
      </main>
    </ElevationProvider>
  );
}

import { useElevation } from '../../index.js';
function ChangeRole({ onDone }: { onDone: (s: string) => void }) {
  const { callPrivileged } = useElevation();
  const [draft, setDraft] = useState('');
  runtime.session.setForms([
    ...(draft === '' ? [] : [{ name: 'Role change reason', saveDraft: async () => true }]),
  ]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void callPrivileged(
          {
            action: 'Request a role change',
            target: 'Dr A. Example: add Compliance officer',
            approver: 'A second administrator, not you',
          },
          async () => {
            const r = await fetch('/api/v1/admin/role-change-requests', { method: 'POST' });
            return { response: r, error: r.ok ? undefined : await r.json() };
          },
        ).then((r) => onDone(r === undefined ? 'cancelled' : `status ${r.response.status}`));
      }}
    >
      <label htmlFor="reason">Reason</label>
      <input
        id="reason"
        className="ehr-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="ehr-btn ehr-btn--primary">
        Request role change
      </button>
    </form>
  );
}

function Root() {
  switch (window.location.pathname) {
    case '/admin':
      return <Admin />;
    case '/sign-in':
      return (
        <main id="main" className="ehr-main">
          <h1>Sign in to the staff portal</h1>
          <AdminSignInLink />
        </main>
      );
    default:
      return (
        <main id="main" className="ehr-main">
          <AdminSignInPage
            runtime={runtime}
            securityKey={key}
            assign={(u) => (document.body.dataset['landed'] = u)}
          />
        </main>
      );
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
