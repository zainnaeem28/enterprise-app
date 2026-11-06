import type { ErrorKind } from '@ehr/ui';

export interface ProblemView {
  kind: ErrorKind;
  requestId?: string;
  retryAfterSeconds?: number;
}

/**
 * Map an API answer to the UI-UX 6 error state. 401 `auth.session_expired` and 400
 * `kernel.client_release_unsupported` are not pages: the session and release stores open their dialogs.
 * 403 and 404 carry no detail on purpose (CN-04).
 */
export function problemView(response: Response, body: unknown): ProblemView | undefined {
  const requestId =
    typeof (body as { requestId?: unknown } | null)?.requestId === 'string'
      ? (body as { requestId: string }).requestId
      : undefined;
  const withId = <T extends ProblemView>(v: T): ProblemView =>
    requestId === undefined ? v : { ...v, requestId };
  const s = response.status;
  if (s === 403) return withId({ kind: 'forbidden' });
  if (s === 404) return withId({ kind: 'not-found' });
  if (s === 412) return withId({ kind: 'conflict' });
  if (s === 429) {
    const n = Number(response.headers.get('Retry-After'));
    return withId({ kind: 'rate-limited', retryAfterSeconds: Number.isFinite(n) && n > 0 ? n : 5 });
  }
  if (s >= 500) return withId({ kind: 'server' });
  return undefined;
}
