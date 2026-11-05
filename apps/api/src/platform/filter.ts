// One exception filter: every failure leaves as the standard body (28.4) with the request id, never a stack,
// a message or a database detail.
import { Catch, HttpException, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { mapDatabaseError } from '@ehr/kernel';
import type { Logger } from '@ehr/kernel';
import { ApiError } from './errors.js';
import type { Req, Res } from './http.js';
import { sendProblem } from './respond.js';

export const LOGGER = Symbol('LOGGER');

/** Any thrown value -> the API error to send. Logs the class of unexpected failures, never their messages. */
export function translateError(err: unknown, req: Req, log: Logger): ApiError {
  if (err instanceof ApiError) return err;
  const o = err as { status?: unknown; statusCode?: unknown } | null;
  const s =
    err instanceof HttpException
      ? err.getStatus()
      : typeof o?.status === 'number'
        ? o.status
        : typeof o?.statusCode === 'number'
          ? o.statusCode
          : undefined;
  if (s === 404 || s === 405) return new ApiError(404, 'kernel.not_found');
  if (s === 413) return new ApiError(413, 'kernel.payload_too_large');
  if (s === 400) return new ApiError(400, 'kernel.validation_failed'); // e.g. malformed JSON
  const m = mapDatabaseError(err, 'kernel');
  // Driver messages can carry values (PHI): log the class and SQLSTATE only.
  log.error('request failed', {
    requestId: req.requestId,
    method: req.method,
    errorName: err instanceof Error ? err.name : typeof err,
    sqlstate: (err as { code?: unknown } | null)?.code,
  });
  return new ApiError(m.status, m.code, m.retryable);
}

/** Express error middleware for failures raised before the Nest router (body parser, our own middleware). */
export function errorMiddleware(log: Logger) {
  // Express recognises error middleware by its four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Req, res: Res, _next: unknown): void =>
    sendProblem(req, res, translateError(err, req, log));
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Req>();
    sendProblem(req, http.getResponse<Res>(), translateError(err, req, this.log));
  }
}
