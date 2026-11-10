// Registry codes of the clinical notes (ARCHITECTURE 29.3, 30). Codes only: no value from the request, no note text, no database text.
// The chart's errors (validation, not found, precondition, invalid transition, merged patient, scope) are reused as they are; the
// codes below are the notes' own.
import { ApiError } from '../../../platform/errors.js';
import {
  ChartError,
  ChartNotFoundError,
  InvalidTransitionError,
  PatientMergedError,
} from '../chart/errors.js';

export {
  ChartNotFoundError as NotesNotFoundError,
  ChartScopeError as NotesScopeError,
  ChartValidationError as NotesValidationError,
  InvalidTransitionError,
  PatientMergedError,
  PreconditionFailedError,
} from '../chart/errors.js';
export { ConsentsMissingError } from '../frontdoor/errors.js';

/** 409 clinical.note_locked: the note is signed, or waits for its co-signature; it changes only through an addendum (BR-11). */
export class NoteLockedError extends ChartError {
  constructor() {
    super('clinical.note_locked', 409);
    this.name = 'NoteLockedError';
  }
}

/** 409 clinical.note_unsigned: the encounter has no signed or submitted note and no deferral was given (ST-01). */
export class NoteUnsignedError extends ChartError {
  constructor() {
    super('clinical.note_unsigned', 409);
    this.name = 'NoteUnsignedError';
  }
}

/** 403 clinical.cosign_not_supervisor: the caller is not the supervisor the note waits for (BR-12). */
export class CosignNotSupervisorError extends ChartError {
  constructor() {
    super('clinical.cosign_not_supervisor', 403);
    this.name = 'CosignNotSupervisorError';
  }
}

/** 401 auth.reauth_required: the sign-in is older than `note_sign_max_auth_age` (BQ-8). The client signs in again and repeats the request. */
export class ReauthRequiredError extends ApiError {
  constructor() {
    super(401, 'auth.reauth_required', false);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * The tables' triggers raise class-P SQLSTATEs (migration 1801): PS001 an illegal change, PM001 a merged patient, PM008 an unknown
 * one; 23505 on the one encounter per reservation and the one co-signature per note. Anything else is rethrown for the platform's
 * database-error mapper.
 */
export function translateDbError(err: unknown): never {
  const e =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown; constraint?: unknown })
      : {};
  switch (e.code) {
    case 'PM001':
      throw new PatientMergedError();
    case 'PM008':
      throw new ChartNotFoundError();
    case 'PS001':
    case '23505':
      throw new InvalidTransitionError();
    default:
      throw err;
  }
}

/**
 * 403 clinical.not_assigned on `GET /notes/{id}` (decision HEAAA-286): the same status and code as the chart's `NotAssignedError`, with
 * the member `btgAvailable` set from the caller's own `audit.btg.open` grant. The platform's problem body does not serialise it yet
 * (filter.ts), the same as for the chart; the class carries it so the follow-up can.
 */
export class NoteNotAssignedError extends ChartError {
  readonly btgAvailable: boolean;
  constructor(btgAvailable: boolean) {
    super('clinical.not_assigned', 403, false, { btgAvailable });
    this.name = 'NoteNotAssignedError';
    this.btgAvailable = btgAvailable;
  }
}
