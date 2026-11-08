// Shared by the profile, privacy and messages features: the reduced shape of a failed call and the guard around the
// shell's typed client. Bodies that the contract types as opaque objects are checked by each feature's own parsers.

/** A refused or failed call, reduced to what the screens use. Never carries a body or a value the patient typed (CN-03). */
export interface Failure {
  ok: false;
  status: number;
  code: string;
  requestId?: string;
  /** Field names from `errors[].path` of a 400 (`/phone` -> `phone`). Names only, never values. */
  fields: string[];
  retryAfterSeconds?: number;
}
export type Outcome<T> = { ok: true; data: T } | Failure;

export const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function failureOf(response: Response | undefined, body: unknown): Failure {
  const b = asRecord(body);
  const errors = Array.isArray(b['errors']) ? b['errors'] : [];
  const fields = errors
    .map((e) => str(asRecord(e)['path']))
    .filter((p): p is string => p !== undefined && p.startsWith('/'))
    .map((p) => p.slice(1).split('/')[0] as string);
  const retry = Number(response?.headers.get('Retry-After'));
  return {
    ok: false,
    status: response?.status ?? 0,
    code: str(b['code']) ?? 'kernel.unavailable',
    ...(str(b['requestId']) !== undefined ? { requestId: str(b['requestId']) as string } : {}),
    fields: [...new Set(fields)],
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
  };
}

const unreadable = (response: Response): Failure => ({
  ok: false,
  status: response.status,
  code: 'kernel.unavailable',
  fields: [],
});

const network = (): Failure => ({ ok: false, status: 0, code: 'kernel.unavailable', fields: [] });

/** New `Idempotency-Key`: a UUID v4. One key per step; a retry of the same step reuses it (CN-06). */
export const newKey = (): string => crypto.randomUUID();

/** Runs one call; a network error or an answer the parser rejects is a server-error state, never a blank screen. */
export async function guard<T>(
  run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  read: (data: unknown, response: Response) => T | undefined,
): Promise<Outcome<T>> {
  try {
    const { data, error, response } = await run();
    if (!response.ok) return failureOf(response, error);
    const value = read(data, response);
    return value === undefined ? unreadable(response) : { ok: true, data: value };
  } catch {
    return network();
  }
}

/** The row version of an `ETag` (`W/"4"` -> 4). */
export function versionOf(response: Response): number | undefined {
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(response.headers.get('ETag')?.trim() ?? '');
  return m === null ? undefined : Number(m[1]);
}

export const ifMatch = (version: number): string => `W/"${version}"`;
