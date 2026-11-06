// Alert routes of ARCHITECTURE 29.3 (`staff.`): GET /alerts, GET /alerts/open-ids (passive), POST /alerts/{id}/acknowledge.
// `GET /alerts/stream` is in ../stream. The guard has authenticated the caller and checked the permission before a handler
// runs; every query here runs under the caller's own scope, so RLS and the "own targets" predicate decide what is visible.
import { Controller, Get, Param, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, ScopeSettings } from '@ehr/kernel';
import {
  IdempotencyConflictError,
  IdempotencyKeyRequiredError,
  beginIdempotent,
  completeIdempotent,
  parseIdempotencyKey,
  requestHash,
} from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { NotificationsError } from '../errors.js';
import type { AlertService } from './service.js';

export interface AlertsControllerDeps {
  db: KernelDb;
  alerts: AlertService;
  /** The caller's scope as the guard resolved it (identity's `requireAuthContext(req).scope`). */
  scopeOf: (req: Req) => ScopeSettings;
}

const ACK_TEMPLATE = '/api/v1/alerts/{id}/acknowledge';

/** A module error leaves as its registry code (30); the platform filter would otherwise map it by status only. */
function toApi(e: unknown): unknown {
  if (e instanceof NotificationsError) return new ApiError(e.status, e.code, e.retryable);
  if (e instanceof IdempotencyConflictError || e instanceof IdempotencyKeyRequiredError)
    return new ApiError(e.status, e.code);
  return e;
}

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function createAlertsController(d: AlertsControllerDeps): Type<unknown> {
  @Controller('api/v1/alerts')
  class AlertsController {
    @Get()
    @Route({ permission: 'notifications.alert.read', resolver: 'none' })
    async list(@ReqParam() req: Req): Promise<unknown> {
      const limit = one(req.query['limit']);
      try {
        return await d.db.withScope(
          d.scopeOf(req),
          (tx) =>
            d.alerts.list(tx, {
              ...(one(req.query['status']) === undefined
                ? {}
                : { status: one(req.query['status']) as string }),
              ...(limit === undefined ? {} : { limit: Number(limit) }),
              ...(one(req.query['cursor']) === undefined
                ? {}
                : { cursor: one(req.query['cursor']) as string }),
            }),
          { idempotent: true },
        );
      } catch (e) {
        throw toApi(e);
      }
    }

    // Passive (26.2): the 60 s background poll. It never extends the idle timer (the guard decides that from the route template).
    @Get('open-ids')
    @Route({ permission: 'notifications.alert.read', resolver: 'none' })
    async openIds(@ReqParam() req: Req): Promise<unknown> {
      try {
        return await d.db.withScope(d.scopeOf(req), (tx) => d.alerts.openIds(tx), {
          idempotent: true,
        });
      } catch (e) {
        throw toApi(e);
      }
    }

    @Post(':id/acknowledge')
    @Route({ permission: 'notifications.alert.acknowledge', resolver: 'none' })
    async acknowledge(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ): Promise<unknown> {
      let key: string;
      try {
        key = parseIdempotencyKey(req.header('idempotency-key'));
      } catch (e) {
        throw toApi(e);
      }
      const hash = requestHash({
        method: 'POST',
        routeTemplate: ACK_TEMPLATE,
        pathParams: [id],
        query: {},
        body: undefined,
      });
      try {
        const out = await d.db.withScope(
          d.scopeOf(req),
          async (tx) => {
            const begun = await beginIdempotent(tx, ACK_TEMPLATE, key, hash);
            if (begun.kind === 'replay' && !begun.reread && begun.response.body !== null)
              return { replay: JSON.parse(begun.response.body.toString('utf8')) as unknown };
            const body = await d.alerts.acknowledge(tx, id, requestCtx(req));
            await completeIdempotent(tx, ACK_TEMPLATE, key, {
              status: 200,
              body: Buffer.from(JSON.stringify(body)),
            });
            return { replay: body as unknown };
          },
          { idempotent: true },
        );
        res.status(200);
        return out.replay;
      } catch (e) {
        throw toApi(e);
      }
    }
  }
  return AlertsController;
}

const requestCtx = (req: Req): { requestId: string } | Record<string, never> =>
  req.requestId === undefined ? {} : { requestId: req.requestId };
