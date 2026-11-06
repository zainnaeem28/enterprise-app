import { Banner, ErrorState } from '@ehr/ui';
import type { Failure } from '../api.js';

/** The UI-UX 6 error states for a failed call. 401 and the release refusal are handled by the shell's dialogs. */
export function Problem({
  failure,
  onRetry,
  onReload,
}: {
  failure: Failure;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  const id = failure.requestId === undefined ? {} : { requestId: failure.requestId };
  const s = failure.status;
  if (s === 403) return <ErrorState kind="forbidden" homeHref="/appointments" {...id} />;
  if (s === 404) return <ErrorState kind="not-found" homeHref="/appointments" {...id} />;
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

/** Plain-language text for the refusals a patient can act on (booking rules, ARCHITECTURE 25.1). */
export const refusalText: Record<string, string> = {
  'scheduling.max_future_reached':
    'You already have the most future appointments we allow for this service. Cancel one or wait until one has passed.',
  'scheduling.overlapping_appointment':
    'You already have an appointment at that time. Choose a different time.',
  'scheduling.licensing_refused':
    'We cannot offer a video visit for the state you chose. Choose an in-person visit or another time.',
  'scheduling.lead_time': 'That time is too soon to book online. Choose a later time.',
  'scheduling.outside_hours': 'That time is not available any more. Choose another time.',
  'scheduling.waitlist_disabled': 'This clinic does not offer a waitlist for this visit.',
  'scheduling.offer_expired': 'This offer has run out.',
  'scheduling.cutoff_passed':
    'This appointment is too close to its start time to change online. Please call the clinic.',
  'scheduling.fee_acceptance_required':
    'This appointment is too close to its start time to change online. Please call the clinic.',
  'scheduling.invalid_transition': 'This appointment can no longer be changed.',
  'kernel.precondition_failed': 'This appointment changed while you were looking at it.',
};

export function Refusal({ failure }: { failure: Failure }) {
  const text = refusalText[failure.code];
  if (text === undefined) return null;
  return (
    <Banner tone="warning">
      {text}
      {failure.requestId !== undefined && (
        <>
          {' '}
          Reference: <code>{failure.requestId}</code>
        </>
      )}
    </Banner>
  );
}

export const isRefusal = (f: Failure): boolean => f.code in refusalText && f.status !== 412;
