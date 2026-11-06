// Registry codes of the messaging module (ARCHITECTURE 29.3, 30). Codes only: no value from a message, a task or the database. They
// extend the platform's ApiError, so the exception filter sends them as the standard error body (28.4).
import { ApiError } from '../../platform/errors.js';

export class MessagingError extends ApiError {
  constructor(code: string, status: number, retryable = false, extras: ApiError['extras'] = {}) {
    super(status, code, retryable, extras);
    this.name = 'MessagingError';
  }
}

export class MessagingValidationError extends MessagingError {
  constructor(readonly fields: readonly string[]) {
    super('kernel.validation_failed', 422, false, {
      errors: fields.map((f) => ({
        path: f.startsWith('/') ? f : `/${f}`,
        code: 'kernel.invalid_value',
      })),
    });
    this.name = 'MessagingValidationError';
  }
}

/** 404 kernel.not_found: absent, hidden by row-level security, or a patient route while patient messaging is off (CN-04, D-5). */
export class MessagingNotFoundError extends MessagingError {
  constructor() {
    super('kernel.not_found', 404);
    this.name = 'MessagingNotFoundError';
  }
}

/**
 * 409 messaging.invalid_transition: the step is not allowed from the thread's or task's state (22.16), for example posting into a
 * closed thread or completing a task twice. PS001 maps here; the code is not in the registry yet (README O-1).
 */
export class InvalidTransitionError extends MessagingError {
  constructor() {
    super('messaging.invalid_transition', 409);
    this.name = 'InvalidTransitionError';
  }
}

/** 422 messaging.participant_invalid: a participant or assignee who is not an active principal of the caller's organisation (TC-MSG-02). */
export class ParticipantInvalidError extends MessagingError {
  constructor(readonly field: string) {
    super('messaging.participant_invalid', 422, false, {
      errors: [{ path: `/${field}`, code: 'messaging.participant_invalid' }],
    });
    this.name = 'ParticipantInvalidError';
  }
}

export class PatientMergedError extends MessagingError {
  constructor() {
    super('patient.merged', 409);
    this.name = 'PatientMergedError';
  }
}

export class PreconditionFailedError extends MessagingError {
  constructor() {
    super('kernel.precondition_failed', 412);
    this.name = 'PreconditionFailedError';
  }
}

/** The caller's transaction lacks what the operation needs (a wrong audience or realm for the method). */
export class MessagingScopeError extends MessagingError {
  constructor() {
    super('auth.forbidden', 403);
    this.name = 'MessagingScopeError';
  }
}

/**
 * The triggers of migration 2001 raise class-P SQLSTATEs: PS001 an illegal step or participant, PM001 a merged patient, PM008 an
 * unknown one. 42501 is row-level security refusing a write (a thread about a patient out of scope, TC-MSG-02 by SQL); 23505 a
 * second task for the same source event. `participantField` names the request field a PS001 on a participant or assignee belongs to.
 */
export function translateDbError(err: unknown, participantField?: string): never {
  const e =
    typeof err === 'object' && err !== null ? (err as { code?: unknown; message?: unknown }) : {};
  switch (e.code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
    case '42501':
      throw new MessagingNotFoundError();
    case 'PS001':
      if (
        participantField !== undefined &&
        /principal|assignee|eligible|role/.test(String(e.message))
      )
        throw new ParticipantInvalidError(participantField);
      throw new InvalidTransitionError();
    case '23505':
      throw new InvalidTransitionError();
    default:
      throw err;
  }
}
