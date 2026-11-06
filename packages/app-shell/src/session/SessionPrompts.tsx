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

  if (state.signOutBlocked) {
    return (
      <AlertDialog
        title={s.signOutBlockedTitle}
        initialFocus="[data-default]"
        actions={
          <>
            <Button data-default variant="primary" onClick={() => store.cancelSignOut()}>
              {s.stayHere}
            </Button>
            <Button onClick={() => void store.signOut(true)}>{s.signOutAnyway}</Button>
          </>
        }
      >
        <p>{s.signOutBlockedBody}</p>
      </AlertDialog>
    );
  }
  if (state.phase === 'ended') return <SessionEndedDialog onSignIn={onSignIn} />;
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
