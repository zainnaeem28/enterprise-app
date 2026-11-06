/** One state per documented answer of sign-in, callback and session (decision HEAAA-172). */
export type ProblemCode =
  | 'kernel.validation_failed'
  | 'patient.merged'
  | 'kernel.rate_limited'
  | 'kernel.unavailable'
  | 'kernel.timeout'
  | 'kernel.not_found'
  | 'identity.sign_in_failed'
  | 'auth.unauthenticated'
  | 'auth.forbidden'
  | 'signin.cancelled'
  | 'signin.expired';

export type ProblemAction = 'retry' | 'sign-in';

export interface ProblemCopy {
  title: string;
  body: string;
  /** What the primary button does: ask the same thing again, or start the sign-in again. */
  action: ProblemAction;
}

export const problemCopy: Record<ProblemCode, ProblemCopy> = {
  'kernel.validation_failed': {
    title: 'We could not start sign-in',
    body: 'The sign-in request was not accepted. Start again from the beginning.',
    action: 'sign-in',
  },
  'patient.merged': {
    title: 'This account was combined with another',
    body: 'Your records now sit under one account. Sign in again to continue.',
    action: 'sign-in',
  },
  'kernel.rate_limited': {
    title: 'Too many attempts',
    body: 'Wait a minute, then try again.',
    action: 'retry',
  },
  'kernel.unavailable': {
    title: 'Sign-in is not available right now',
    body: 'The service is busy or down for a short time. Try again in a moment.',
    action: 'retry',
  },
  'kernel.timeout': {
    title: 'Sign-in took too long',
    body: 'The service did not answer in time. Try again.',
    action: 'retry',
  },
  'kernel.not_found': {
    title: 'This page is not part of the patient portal',
    body: 'Use the sign-in button to start again.',
    action: 'sign-in',
  },
  'identity.sign_in_failed': {
    title: 'We could not sign you in',
    body: 'Sign-in did not complete. Start again.',
    action: 'sign-in',
  },
  'auth.unauthenticated': {
    title: 'You are not signed in',
    body: 'Sign in to see your account.',
    action: 'sign-in',
  },
  'auth.forbidden': {
    title: 'This account cannot use the patient portal',
    body: 'Sign in with a patient account, or contact the clinic for help.',
    action: 'sign-in',
  },
  'signin.cancelled': {
    title: 'Sign-in was cancelled',
    body: 'Nothing was changed. Start again when you are ready.',
    action: 'sign-in',
  },
  'signin.expired': {
    title: 'Your sign-in took too long',
    body: 'The secure sign-in page timed out. Start again.',
    action: 'sign-in',
  },
};

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && Object.hasOwn(problemCopy, value);
}

/** Documented code of an answer; an unknown code falls back by status so a state is always shown. */
export function problemCodeOf(status: number, body: unknown): ProblemCode {
  const code = (body as { code?: unknown } | null | undefined)?.code;
  if (isProblemCode(code)) return code;
  if (status === 429) return 'kernel.rate_limited';
  if (status === 504) return 'kernel.timeout';
  if (status === 401) return 'auth.unauthenticated';
  if (status === 403) return 'auth.forbidden';
  if (status === 409) return 'patient.merged';
  if (status === 400) return 'kernel.validation_failed';
  if (status === 404) return 'kernel.not_found';
  return 'kernel.unavailable';
}

export interface Problem {
  code: ProblemCode;
  requestId?: string;
}

export function requestIdOf(body: unknown): string | undefined {
  const id = (body as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof id === 'string' && id.length <= 128 ? id : undefined;
}
