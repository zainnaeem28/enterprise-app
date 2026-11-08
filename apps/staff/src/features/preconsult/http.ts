import type { ShellRuntime } from '@ehr/app-shell';

export type Api = ShellRuntime['api'];

/** A refused or failed call reduced to what the screens use. `status` 0 is a network failure. */
export interface Failure {
  ok: false;
  status: number;
  code: string;
  requestId?: string;
  retryAfterSeconds?: number;
  /** Field paths the server named (CN-03: paths and codes, never values). */
  fields: string[];
  /** 409 `patient.merged` names the survivor only when the caller may read it (ARCHITECTURE 9.2). */
  survivorId?: string;
}
export type Outcome<T> = { ok: true; data: T; etag?: number } | Failure;

export const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const newKey = (): string => crypto.randomUUID();

/** `If-Match` for a version we hold. An unknown version sends nothing (the server answers 428) rather than an invented one. */
export const matchHeader = (version: number | undefined): { 'If-Match': string } =>
  (version === undefined ? {} : { 'If-Match': `W/"${version}"` }) as { 'If-Match': string };

export const NETWORK: Failure = { ok: false, status: 0, code: 'kernel.unavailable', fields: [] };

export function failureOf(response: Response | undefined, body: unknown): Failure {
  const b = rec(body);
  const fields = arr(b['errors'])
    .map((e) => str(rec(e)['path']))
    .filter((p): p is string => p !== undefined)
    .map((p) => p.replace(/^\//, ''));
  const survivor = arr(b['errors'])
    .map(rec)
    .find((e) => e['path'] === '/survivorId' && typeof e['code'] === 'string');
  const retry = Number(response?.headers.get('Retry-After'));
  return {
    ok: false,
    status: response?.status ?? 0,
    code: typeof b['code'] === 'string' ? b['code'] : 'kernel.unavailable',
    ...(typeof b['requestId'] === 'string' ? { requestId: b['requestId'] } : {}),
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    fields,
    ...(survivor === undefined ? {} : { survivorId: survivor['code'] as string }),
  };
}

export const etagOf = (response: Response): number | undefined => {
  const m = /(\d+)"?$/.exec(response.headers.get('ETag') ?? '');
  return m === null ? undefined : Number(m[1]);
};

/** Runs one typed call and parses its body. `read` returning undefined means "not the shape the contract promises". */
export async function guard<T>(
  run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  read: (data: unknown, response: Response) => T | undefined,
): Promise<Outcome<T>> {
  try {
    const { data, error, response } = await run();
    if (!response.ok) return failureOf(response, error);
    const value = read(data, response);
    if (value === undefined)
      return { ok: false, status: response.status, code: 'kernel.unavailable', fields: [] };
    const etag = etagOf(response);
    return { ok: true, data: value, ...(etag === undefined ? {} : { etag }) };
  } catch {
    return NETWORK;
  }
}
