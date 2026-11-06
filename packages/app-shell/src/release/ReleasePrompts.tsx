import { useState, useSyncExternalStore } from 'react';
import { AlertDialog, Button, StatusBar } from '@ehr/ui';
import type { ReleaseStore } from './release-store.js';
import { releaseStrings as s } from './strings.js';

export function useReleaseState(store: ReleaseStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Non-blocking bar for a newer release, plus the blocking dialog after a refused call (UI-UX 7.7). */
export function ReleasePrompts({ store }: { store: ReleaseStore }) {
  const state = useReleaseState(store);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const unsaved = state.forms.length > 0;
  const saveable = state.forms.some((f) => f.saveDraft !== undefined);

  const onReload = () => {
    if (unsaved) setConfirming(true);
    else store.reload();
  };

  return (
    <>
      {state.refused && state.keepOpen && <StatusBar tone="danger">{s.keepOpenBar}</StatusBar>}
      {store.barVisible() && (
        <StatusBar
          tone="info"
          actions={
            <>
              <Button variant="primary" onClick={onReload}>
                {s.reload}
              </Button>
              <Button onClick={() => store.remindLater()}>{s.remindLater}</Button>
            </>
          }
        >
          {s.barText}
          {unsaved ? ` ${s.barUnsaved}` : ''}
        </StatusBar>
      )}
      {confirming && !state.refused && (
        <AlertDialog
          title={s.confirmTitle}
          initialFocus="[data-default]"
          actions={
            <>
              <Button data-default onClick={() => setConfirming(false)}>
                {s.stay}
              </Button>
              {saveable && (
                <Button
                  variant="primary"
                  onClick={async () => setSaveError(!(await store.saveDraftsAndReload()))}
                >
                  {s.saveAndReload}
                </Button>
              )}
              <Button onClick={() => store.reload()}>{s.reloadAnyway}</Button>
            </>
          }
        >
          <p>{s.confirmIntro}</p>
          <ul>
            {state.forms.map((f) => (
              <li key={f.name}>{f.name}</li>
            ))}
          </ul>
          {saveError && <p role="alert">{s.saveFailed}</p>}
        </AlertDialog>
      )}
      {state.refused && !state.keepOpen && (
        <AlertDialog
          title={s.blockedTitle}
          actions={
            <>
              <Button variant="primary" onClick={() => store.reload()}>
                {s.reload}
              </Button>
              <Button onClick={() => store.keepPageOpen()}>{s.keepOpen}</Button>
            </>
          }
        >
          <p>{s.blockedText}</p>
          {state.requestId !== undefined && (
            <p>
              {s.requestIdLabel} <code>{state.requestId}</code>
            </p>
          )}
        </AlertDialog>
      )}
    </>
  );
}

/** Shown in the alert bar when the live alert stream is refused; never looks like "no alerts". */
export function AlertsPausedBar({ store }: { store: ReleaseStore }) {
  const state = useReleaseState(store);
  if (!state.refused) return null;
  return (
    <StatusBar
      tone="danger"
      actions={
        <Button variant="primary" onClick={() => store.reload()}>
          {s.reload}
        </Button>
      }
    >
      {s.alertsPaused}
    </StatusBar>
  );
}
