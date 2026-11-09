import { ApiError, problemBody } from './errors.js';
import type { Req, Res } from './http.js';

/** Write the standard error response (28.4). Safe to call once; a started response is only closed. */
export function sendProblem(req: Req, res: Res, err: ApiError): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(err.status);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  if (err.status === 429 || err.status === 503) {
    const after = err.extras.retryAfterSeconds ?? (err.status === 503 ? 5 : 1);
    res.setHeader('Retry-After', String(after));
  }
  res.end(JSON.stringify(problemBody(err, req.requestId ?? 'unknown')));
}
