import { useEffect, useSyncExternalStore } from 'react';
import { AlertDialog, Button, SessionEndedDialog, SessionWarningDialog, StatusBar } from '@ehr/ui';
import type { SessionStore } from './session-store.js';
import { sessionStrings as s } from './strings.js';

export function useSessionState(store: SessionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * Idle warning (2:00 before the deadline), the 401 "session ended" dialog, and the held-back sign-out
 * dialog. The warning takes focus and reads out the time once (SessionWarningDialog); Escape is "Stay
 * signed in" so a screen-reader user is never trapped (UI-UX 7.1).
 */
export function SessionPrompts({
  store,
  onSignIn,
}: {
  store: SessionStore;
  /** Navigate to sign-in; the route is kept so sign-in returns here (no PHI in routes). */
  onSignIn: () => void;
}) {
  const state = useSessionState(store);
  useEffect(() => {
    if (state.phase !== 'warning') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void store.extend();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.phase, store]);

  if (state.phase === 'ended') return <SessionEndedDialog onSignIn={onSignIn} />;
  const held = state.signOutBlocked
    ? { title: s.signOutBlockedTitle, body: <p>{s.signOutBlockedBody}</p>, retry: s.signOutAnyway }
    : state.lossWarning !== undefined
      ? {
          title: s.unsavedTitle,
          body: (
            <>
              <p>{s.unsavedBody}</p>
              <ul>
                {state.lossWarning.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          ),
          retry: s.signOutAnyway,
        }
      : state.signOutFailed
        ? { title: s.signOutFailedTitle, body: <p>{s.signOutFailedBody}</p>, retry: s.tryAgain }
        : undefined;
  if (held !== undefined) {
    const mm = Math.floor(state.secondsLeft / 60);
    const ss = String(state.secondsLeft % 60).padStart(2, '0');
    return (
      <AlertDialog
        title={held.title}
        initialFocus="[data-default]"
        actions={
          <>
            <Button data-default variant="primary" onClick={() => store.cancelSignOut()}>
              {s.goBack}
            </Button>
            <Button onClick={() => void store.signOut(true)}>{held.retry}</Button>
          </>
        }
      >
        {held.body}
        {state.phase === 'warning' && <p role="timer">{s.endsIn(`${mm}:${ss}`)}</p>}
      </AlertDialog>
    );
  }
  if (state.phase !== 'warning') return null;
  return (
    <>
      {state.extendFailed && <StatusBar tone="danger">{s.extendFailed}</StatusBar>}
      <SessionWarningDialog
        secondsLeft={state.secondsLeft}
        onStay={() => void store.extend()}
        onSignOut={() => void store.signOut()}
      />
    </>
  );
}
