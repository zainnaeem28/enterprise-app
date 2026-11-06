// The routes of calendar-sync (ARCHITECTURE 29.3, 29.5, 27.1): the doctor's calendar link and the Google push webhook.
//   GET    /calendar-link            own link status
//   POST   /calendar-link/start      the Google consent URL (state and PKCE challenge inside; nothing stored but the pending link)
//   GET    /calendar-link/callback   top-level browser navigation (exempt from the release header, 28.6): 302 back to the portal
//   DELETE /calendar-link            unlink
//   POST   /webhooks/google/calendar public (no session): verified by the channel token (29.5)
// Each link route declares {calendar.link.own, google realm}. By the time a handler runs the guard has authenticated, checked CSRF
// (the callback is a GET), the realm and the permission, and the handler opens one transaction under the caller's own scope.
import { randomUUID } from 'node:crypto';
import { Controller, Delete, Get, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, Tx } from '@ehr/kernel';
import { PUBLIC } from '../../platform/permissions.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import type { ResourceResolver } from '../identity/index.js';
import type { RequestMeta } from '../audit/index.js';
import type { CalendarLinkService } from './service.js';
import type { GoogleCalendarPush } from './push.js';

export interface CalendarControllerDeps {
  db: KernelDb;
  links: CalendarLinkService;
  push: GoogleCalendarPush;
  /** Where the browser lands after the callback (the doctor portal's calendar page). `?calendar=linked|denied|error` is appended. */
  returnUrl: string;
}

const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? randomUUID(),
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

/** The link is the doctor's own and there is no other resource: the resolver only says "own"; the service reads under the caller's RLS. */
export function calendarResolvers(): Record<string, ResourceResolver> {
  return { 'calendar-own': () => Promise.resolve({}) };
}

export function createCalendarControllers(d: CalendarControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  @Controller('api/v1/calendar-link')
  class CalendarLinkController {
    @Get()
    @Route({ permission: 'calendar.link.own', resolver: 'calendar-own', realm: 'google' })
    async status(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      send(res, 200, await run(req, (tx) => d.links.status(tx)));
    }

    @Post('start')
    @Route({ permission: 'calendar.link.own', resolver: 'calendar-own', realm: 'google' })
    async start(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      send(res, 200, await run(req, (tx) => d.links.start(tx, metaOf(req))));
    }

    @Get('callback')
    @Route({
      permission: 'calendar.link.own',
      resolver: 'calendar-own',
      realm: 'google',
      releaseExempt: true,
    })
    async callback(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const outcome = await d.links.complete(requireAuthContext(req).scope, metaOf(req), {
        code: req.query['code'],
        state: req.query['state'],
        error: req.query['error'],
      });
      // The code and state never leave this request: the redirect carries a fixed outcome word only.
      const target = new URL(d.returnUrl);
      target.searchParams.set('calendar', outcome);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Location', target.toString());
      res.status(302).end();
    }

    @Delete()
    @Route({ permission: 'calendar.link.own', resolver: 'calendar-own', realm: 'google' })
    async unlink(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await run(req, (tx) => d.links.unlink(tx, metaOf(req)));
      send(res, 200, {});
    }
  }

  @Controller('webhooks/google')
  class GoogleWebhookController {
    @Post('calendar')
    @Route({ permission: PUBLIC, resolver: 'none', releaseExempt: true })
    async calendar(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const r = await d.push.receive(req.headers);
      send(res, r.status, {});
    }
  }

  return [CalendarLinkController, GoogleWebhookController];
}
