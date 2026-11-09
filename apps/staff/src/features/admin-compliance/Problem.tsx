import { Banner } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { failureOf, rec } from '../preconsult/http.js';
import { adminStrings as s } from './strings.js';

export { LoadError } from '../preconsult/Problem.js';

/** A privileged call's loose answer (`callPrivileged` returns it) reduced to success with a parsed body, or one Failure. */
export async function readAnswer<T>(
  answer: { data?: unknown; error?: unknown; response: Response } | undefined,
  read: (data: unknown) => T | undefined,
): Promise<{ ok: true; data: T } | Failure | undefined> {
  if (answer === undefined) return undefined; // the administrator cancelled the key dialog; the form keeps what was typed
  if (!answer.response.ok) return failureOf(answer.response, answer.error);
  const data = read(answer.data);
  return data === undefined
    ? { ok: false, status: answer.response.status, code: 'kernel.unavailable', fields: [] }
    : { ok: true, data };
}
export const body = rec;

/** Text for a refused action, from the registry codes these routes return (ARCHITECTURE 29.3, 30). Never a value from the request. */
export function failureText(f: Failure): string {
  switch (f.code) {
    case 'audit.self_review':
      return s.btgSelfReview;
    case 'audit.invalid_transition':
      return s.btgAlready;
    case 'audit.export_too_large':
      return s.exportTooLarge;
    case 'identity.self_approval':
      return s.selfApproval;
    case 'identity.approver_is_subject':
      return s.approverIsSubject;
    case 'identity.request_expired':
      return s.requestExpired;
    case 'identity.privileged_role_in_staff_realm':
      return s.forStaffRealm;
    case 'identity.role_realm_mismatch':
      return s.roleRealmMismatch;
    case 'kernel.precondition_failed':
    case 'kernel.precondition_required':
      return s.conflict;
    case 'privacy.invalid_transition':
    case 'kernel.state_conflict':
      return s.invalidTransition;
  }
  if (f.status === 0)
    return 'You are offline. Nothing was saved. Try again when you are back online.';
  if (f.status === 401) return 'Your session ended. Sign in again, then repeat this.';
  if (f.status === 403) return s.forbidden;
  if (f.status === 404) return "We can't find this, or it isn't available to you.";
  if (f.status === 429) return `Too many tries. Try again in ${f.retryAfterSeconds ?? 5} s.`;
  if (f.status === 409) return s.invalidTransition;
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
