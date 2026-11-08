import { ErrorState } from '@ehr/ui';
import type { Failure } from './core.js';

/** The UI-UX 6 error states for a failed call. 401 and the release refusal are handled by the shell's dialogs. */
export function Problem({
  failure,
  onRetry,
  onReload,
  homeHref = '/appointments',
}: {
  failure: Failure;
  onRetry?: () => void;
  onReload?: () => void;
  homeHref?: string;
}) {
  const id = failure.requestId === undefined ? {} : { requestId: failure.requestId };
  const s = failure.status;
  if (s === 403) return <ErrorState kind="forbidden" homeHref={homeHref} {...id} />;
  if (s === 404) return <ErrorState kind="not-found" homeHref={homeHref} {...id} />;
  if (s === 412) return <ErrorState kind="conflict" {...(onReload ? { onReload } : {})} {...id} />;
  if (s === 429)
    return (
      <ErrorState
        kind="rate-limited"
        retryAfterSeconds={failure.retryAfterSeconds ?? 5}
        {...(onRetry ? { onRetry } : {})}
        {...id}
      />
    );
  return <ErrorState kind="server" {...(onRetry ? { onRetry } : {})} {...id} />;
}
