// `GET /alerts/stream` (ARCHITECTURE 32.1) over the StreamHub. The platform layer ships a transport-only controller for this
// route (apps/api/src/platform/stream.ts, F-05); at integration it is replaced by this one (README, ALR-N3), because two
// controllers cannot own one route. Release check, session, permission and the `X-Session-Idle-Expires-At` rule (passive)
// all happen before the handler, in the middleware and the guard.
import { Controller, Get, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { Req } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import type { StreamHub, StreamIdentity, StreamResponse } from './hub.js';
import { ALERT_REALMS } from '../alerts/types.js';

/** Maps the authenticated request to the stream identity (identity's `requireAuthContext` in the composition root). */
export type IdentityOf = (req: Req) => StreamIdentity;

export function createAlertStreamController(hub: StreamHub, identityOf: IdentityOf): Type<unknown> {
  @Controller('api/v1/alerts')
  class AlertStreamController {
    @Get('stream')
    @Route({
      permission: 'notifications.alert.read',
      resolver: 'none',
      realm: [...ALERT_REALMS],
      routeClass: 'stream',
    })
    async stream(@ReqParam() req: Req, @ResParam() res: StreamResponse): Promise<void> {
      await hub.attach(res, identityOf(req), req.headers['last-event-id']);
    }
  }
  return AlertStreamController;
}
