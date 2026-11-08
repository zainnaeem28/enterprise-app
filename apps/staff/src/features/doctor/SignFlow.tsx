import { AlertDialog, Button, uiStrings } from '@ehr/ui';
import { docStrings as d } from './strings.js';

/** The second sign-in is a top-level POST that answers 302 to the identity provider, so it opens in a new tab and this page keeps the draft. */
export function openReauthTab(returnTo: string) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/v1/auth/reauth?returnTo=${encodeURIComponent(returnTo)}`;
  form.target = '_blank';
  form.style.display = 'none';
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

/**
 * `401 auth.reauth_required` (UI-UX 7.1): sign in again in the other tab, then repeat the same request with the same
 * `Idempotency-Key` from this page. The draft is saved on the server before the request and stays on this page.
 */
export function ReauthRetryDialog({
  opened,
  onOpen,
  onRetry,
  onCancel,
  retryLabel,
}: {
  opened: boolean;
  onOpen: () => void;
  onRetry: () => void;
  onCancel: () => void;
  retryLabel: string;
}) {
  return (
    <AlertDialog
      title={uiStrings.reauthTitle}
      initialFocus="[data-first]"
      actions={
        <>
          {!opened ? (
            <Button variant="primary" data-first onClick={onOpen}>
              {d.reauthOpen}
            </Button>
          ) : (
            <Button variant="primary" data-first onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {opened && <Button onClick={onOpen}>{d.reauthOpen}</Button>}
          <Button onClick={onCancel}>{uiStrings.cancel}</Button>
        </>
      }
    >
      <p>{opened ? d.reauthOpened : uiStrings.reauthBody}</p>
    </AlertDialog>
  );
}
