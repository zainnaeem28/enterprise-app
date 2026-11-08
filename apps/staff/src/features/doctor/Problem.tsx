import { Banner } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';

export { LoadError } from '../preconsult/Problem.js';

/** Text for a refused write, from the registry codes the note and alert routes return (ARCHITECTURE 30). No value from the request. */
export function failureText(f: Failure): string {
  switch (f.code) {
    case 'kernel.precondition_failed':
    case 'kernel.precondition_required':
      return d.conflict;
    case 'clinical.note_locked':
      return d.noteLocked;
    case 'clinical.supervisor_missing':
      return d.supervisorMissing;
    case 'clinical.cosign_not_supervisor':
      return d.cosignNotSupervisor;
    case 'clinical.consents_missing':
      return d.consentsMissing;
    case 'notifications.alert_closed':
      return d.alertClosedGone;
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
  return (
    <Banner tone="danger">
      <p>{failureText(failure)}</p>
      {server && failure.requestId !== undefined && (
        <p>
          Reference: <code>{failure.requestId}</code>
        </p>
      )}
    </Banner>
  );
}
