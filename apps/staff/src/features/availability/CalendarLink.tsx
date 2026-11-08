import { useEffect, useState } from 'react';
import { AlertDialog, Banner, Button, LoadingState, PermissionNote, StatusChip } from '@ehr/ui';
import { useAvailability } from './AvailabilityContext.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import type { Failure } from '../preconsult/http.js';
import { dateTimeOf } from '../doctor/format.js';
import { avStrings as s } from './strings.js';
import type { LinkStatus } from './types.js';

export type Landing = 'linked' | 'denied' | 'error';

const STATE: Record<
  LinkStatus,
  { tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; title: string; body: string }
> = {
  not_linked: { tone: 'neutral', title: s.stateNot, body: s.stateNotBody },
  pending_consent: { tone: 'info', title: s.statePending, body: s.statePendingBody },
  active: { tone: 'success', title: s.stateActive, body: s.stateActiveBody },
  token_revoked: { tone: 'warning', title: s.stateRevoked, body: s.stateRevokedBody },
  error: { tone: 'danger', title: s.stateError, body: s.stateErrorBody },
};

/** The Google consent address is the only place the browser may be sent to (a fixed host, https). */
export const isGoogleConsent = (u: string): boolean => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
};

/** DR-13: connect Google Calendar. Consent text first, then the connection state; busy-only sync is stated in both. */
export function CalendarLink({ landing }: { landing: Landing | null }) {
  const { api, can, go, online } = useAvailability();
  const allowed = can('calendar.link.own');
  const { state, reload } = useLoad(() => api.link(), [], allowed);
  const [failure, setFailure] = useState<string | Failure | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The callback lands here with ?calendar=…; the word is shown once and the status is read again from the server.
  useEffect(() => {
    if (landing === null) return;
    setNote(
      landing === 'linked'
        ? s.landingLinked
        : landing === 'denied'
          ? s.landingDenied
          : s.landingError,
    );
  }, [landing]);

  if (!allowed) return <PermissionNote scope={s.noPermission} />;
  if (state.kind === 'loading') return <LoadingState label={s.calTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;

  const link = state.data;
  const view = STATE[link.status];
  const connected = link.status === 'active';

  const connect = async () => {
    setStarting(true);
    setFailure(null);
    setNote(null);
    const out = await api.startLink();
    if (!out.ok) {
      setStarting(false);
      return setFailure(out.status === 0 || out.status >= 500 ? out : s.startFailed);
    }
    if (!isGoogleConsent(out.data.authorizationUrl)) {
      setStarting(false);
      return setFailure(s.badRedirect);
    }
    go(out.data.authorizationUrl);
  };

  return (
    <section aria-labelledby="av-cal-title">
      <h2 id="av-cal-title">{s.calTitle}</h2>
      <p>{s.calIntro}</p>
      {note !== null && (
        <Banner tone={landing === 'linked' ? 'info' : 'warning'}>
          <p>{note}</p>
        </Banner>
      )}
      <div className="ehr-av-card" role="group" aria-labelledby="av-cal-state">
        <h3 id="av-cal-state">{s.stateTitle}</h3>
        <p>
          <StatusChip tone={view.tone}>{view.title}</StatusChip>
        </p>
        <p>{view.body}</p>
        {connected && (
          <p className="ehr-muted">
            {link.lastSyncedAt === null ? s.neverSynced : s.lastSync(dateTimeOf(link.lastSyncedAt))}
          </p>
        )}
        {failure !== null &&
          (typeof failure === 'string' ? (
            <Banner tone="danger">
              <p>{failure}</p>
            </Banner>
          ) : (
            <ActionError failure={failure} />
          ))}
        <div className="ehr-av-actions">
          {link.status !== 'active' && (
            <Button variant="primary" disabled={!online || starting} onClick={() => void connect()}>
              {starting
                ? s.connecting
                : link.status === 'token_revoked' || link.status === 'error'
                  ? s.reconnect
                  : s.connect}
            </Button>
          )}
          {link.status !== 'not_linked' && (
            <Button disabled={!online} onClick={() => setConfirm(true)}>
              {s.disconnect}
            </Button>
          )}
        </div>
      </div>

      <div className="ehr-av-card">
        <h3>{s.consentTitle}</h3>
        <ul>
          {s.consent.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Banner tone="info" announce={false}>
          <p>{s.busyOnly}</p>
        </Banner>
        <p className="ehr-muted">{s.disconnectNote}</p>
      </div>
      {confirm && (
        <DisconnectDialog
          onClose={() => setConfirm(false)}
          onDone={() => {
            setConfirm(false);
            setNote(s.disconnected);
            reload();
          }}
        />
      )}
    </section>
  );
}

function DisconnectDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { api, online } = useAvailability();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <AlertDialog
      title={s.disconnectTitle}
      initialFocus="[data-first]"
      actions={
        <>
          <Button
            variant="primary"
            disabled={!online || busy}
            onClick={async () => {
              setBusy(true);
              const out = await api.unlink();
              setBusy(false);
              if (out.ok) onDone();
              else setFailure(out);
            }}
          >
            {s.disconnect}
          </Button>
          <Button data-first onClick={onClose}>
            {s.cancel}
          </Button>
        </>
      }
    >
      <p>{s.disconnectBody}</p>
      {failure !== null && <ActionError failure={failure} />}
    </AlertDialog>
  );
}
