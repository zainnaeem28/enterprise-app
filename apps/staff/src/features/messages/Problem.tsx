import { Banner } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { msgStrings as s } from './strings.js';

export { LoadError } from '../preconsult/Problem.js';

/** Text for a refused write, from the registry codes these routes return (ARCHITECTURE 29.3, 30). No value from the request. */
export function failureText(f: Failure): string {
  switch (f.code) {
    case 'kernel.precondition_failed':
    case 'kernel.precondition_required':
      return s.conflict;
    case 'kernel.idempotency_conflict':
      return 'That request was already used for different details. Review the form and send it again.';
    case 'kernel.payload_too_large':
      return s.errTooLong;
    case 'patient.merged':
      return 'This record was merged into another one. Open the surviving record to continue.';
  }
  if (f.status === 0) return s.offlineWrites;
  if (f.status === 401) return 'Your session ended. Sign in again, then repeat this.';
  if (f.status === 403) return "You don't have access to this, or you are not allowed to do it.";
  if (f.status === 404)
    return "We can't find this, or it isn't available to you. Recipients must be colleagues in your organisation.";
  if (f.status === 429) return `Too many tries. Try again in ${f.retryAfterSeconds ?? 5} s.`;
  if (f.status === 422 || f.status === 400)
    return 'Some details need changing. Check the fields and try again.';
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
