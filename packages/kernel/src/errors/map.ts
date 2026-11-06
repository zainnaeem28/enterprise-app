// ARCHITECTURE 30: PostgreSQL errors map to registry codes. Bodies carry codes and titles only: never the database
// message, detail, hint, constraint values or row data, because any of them can contain PHI.

export interface ApiErrorBody {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
  errors?: { path: string; code: string }[];
}

export interface MappedError {
  status: number;
  code: string;
  title: string;
  retryable: boolean;
  /** Set for 40001/40P01: the kernel retries the whole transaction (25.2) before answering. */
  internalRetry: boolean;
  /** 42501 and RLS WITH CHECK failures: a by-ID write answers 404, anything else 403; always audited. */
  audit: boolean;
}

const TITLES: Record<string, string> = {
  'patient.merged': 'This patient record has been merged',
  'scheduling.slot_taken': 'This time is no longer available',
  'scheduling.invalid_transition': 'This change is not allowed in the current state',
  'kernel.idempotency_conflict': 'The idempotency key was used for a different request',
  'kernel.unavailable': 'The service is temporarily unavailable',
  'kernel.timeout': 'The request timed out',
  'kernel.not_found': 'Not found',
  'auth.forbidden': 'Forbidden',
  'kernel.internal': 'Unexpected error',
};

const REASON_CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function make(
  status: number,
  code: string,
  retryable: boolean,
  flags: Partial<MappedError> = {},
): MappedError {
  return {
    status,
    code,
    title: TITLES[code] ?? code,
    retryable,
    internalRetry: false,
    audit: false,
    ...flags,
  };
}

export interface PgErrorLike {
  code?: unknown;
  detail?: unknown;
  table?: unknown;
  schema?: unknown;
  constraint?: unknown;
}

export interface MapContext {
  /** by-ID write (PATCH, state change on /x/{id}): authorization failure is hidden as 404 (CN-04). */
  byIdWrite?: boolean;
  /** Retries already spent on 40001/40P01; after the second the answer is 503. */
  retriesExhausted?: boolean;
}

/**
 * Map a database or driver error to the API error of section 30. Unknown errors become a generic 500 with no detail.
 * `PS001` has no module in the SQLSTATE, so the caller passes the module of the route.
 */
export function mapDatabaseError(err: unknown, module: string, ctx: MapContext = {}): MappedError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as PgErrorLike;
  const sqlstate = typeof e.code === 'string' ? e.code : '';
  switch (sqlstate) {
    case 'PM001':
      return make(409, 'patient.merged', false);
    case 'PS001':
      return make(409, `${/^[a-z_]+$/.test(module) ? module : 'kernel'}.invalid_transition`, false);
    case 'PS002': {
      // The reason code is the only DETAIL content we trust, and only when it has the registry's shape.
      const detail = typeof e.detail === 'string' ? e.detail.trim() : '';
      const code = REASON_CODE.test(detail) ? detail : 'scheduling.invalid_transition';
      return make(422, code, false);
    }
    case 'PK001':
      return make(409, 'kernel.idempotency_conflict', false);
    case 'PA001':
      return make(500, 'kernel.internal', false);
    case '23P01':
      return make(409, 'scheduling.slot_taken', false);
    case '40001':
    case '40P01':
      return ctx.retriesExhausted
        ? make(503, 'kernel.unavailable', true)
        : make(503, 'kernel.unavailable', true, { internalRetry: true });
    case '57014':
    case '25P04':
      return make(504, 'kernel.timeout', true);
    case '42501':
    case '42P17': // never expected; treated as an authorization-class failure rather than leaking
      return ctx.byIdWrite
        ? make(404, 'kernel.not_found', false, { audit: true })
        : make(403, 'auth.forbidden', false, { audit: true });
    case '57P01':
    case '57P02':
    case '57P03':
    case '08000':
    case '08003':
    case '08006':
    case '53300':
      return make(503, 'kernel.unavailable', true);
    default:
      // 23505 on the idempotency row is handled by the store (replay path), not by this mapper.
      return make(500, 'kernel.internal', false);
  }
}

/** RLS `WITH CHECK` violations arrive as 42501 with message "new row violates row-level security policy". */
export function isRlsViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as PgErrorLike).code === '42501';
}

export function toProblem(
  mapped: MappedError,
  requestId: string,
  errors?: { path: string; code: string }[],
): ApiErrorBody {
  const slug = mapped.code.replace('.', '/');
  const body: ApiErrorBody = {
    type: `https://errors.invalid/${slug}`,
    title: mapped.title,
    status: mapped.status,
    code: mapped.code,
    requestId,
    retryable: mapped.retryable,
  };
  if (errors && errors.length > 0)
    body.errors = errors.map((x) => ({ path: x.path, code: x.code }));
  return body;
}
