import { Banner, ErrorState } from '@ehr/ui';
import { useContext } from 'react';
import { Button } from '@ehr/ui';
import { DeskContext } from './DeskContext.js';
import type { Failure } from './http.js';
import { preStrings as p } from './strings.js';

/** Text for a refused write, from the registry codes the desk routes can return (ARCHITECTURE 30). No value from the request. */
export function failureText(f: Failure): string {
  switch (f.code) {
    case 'kernel.precondition_failed':
      return 'Someone changed this while you were editing. Refresh the list and check before you try again.';
    case 'kernel.precondition_required':
      return 'This list is out of date. Refresh it and try again.';
    case 'scheduling.check_in_not_allowed':
      return 'This visit cannot be checked in now. It may be on another day or at another location, or it is already finished.';
    case 'scheduling.grace_not_elapsed':
      return 'The grace period for this visit has not passed yet, so it cannot be marked as a no-show.';
    case 'patient.merge_pending':
      return p.mergePending;
    case 'patient.already_merged':
    case 'patient.merged':
      return p.mergedRecord;
    case 'patient.merge_self_approval':
      return p.mergeSelfApproval;
    case 'patient.match_check_stale':
    case 'patient.match_check_required':
      return 'The existing-record check is out of date. Check again before you register.';
    case 'kernel.idempotency_conflict':
      return 'That request was already used for different details. Review the form and send it again.';
  }
  if (f.status === 403) return "You don't have access to this.";
  if (f.status === 404) return "We can't find this, or it isn't available to you.";
  if (f.status === 429) return `Too many tries. Try again in ${f.retryAfterSeconds ?? 5} s.`;
  if (f.status === 422 || f.status === 400)
    return 'Some details need changing. Check the fields named above.';
  return 'Something went wrong on our side. Your work is safe.';
}

/** A write that failed: in place, announced, with the reference code for support on server errors (UI-UX 6). */
export function ActionError({ failure }: { failure: Failure }) {
  const server = failure.status === 0 || failure.status >= 500;
  const openChart = useContext(DeskContext)?.openChart;
  return (
    <Banner tone="danger">
      <p>{failureText(failure)}</p>
      {failure.code === 'patient.merged' &&
        failure.survivorId !== undefined &&
        openChart !== undefined && (
          <Button onClick={() => openChart(failure.survivorId as string)}>
            {p.mergedOpenChart}
          </Button>
        )}
      {server && failure.requestId !== undefined && (
        <p>
          Reference: <code>{failure.requestId}</code>
        </p>
      )}
    </Banner>
  );
}

/** A list or panel that could not load (UI-UX 6: 403, 404, 429 and 5xx each have their own text). */
export function LoadError({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const kind =
    failure.status === 403
      ? 'forbidden'
      : failure.status === 404
        ? 'not-found'
        : failure.status === 429
          ? 'rate-limited'
          : 'server';
  return (
    <ErrorState
      kind={kind}
      onRetry={onRetry}
      {...(failure.requestId === undefined ? {} : { requestId: failure.requestId })}
      {...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds })}
    />
  );
}
