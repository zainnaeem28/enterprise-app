// The routes of the `integrations.` host that this module owns (ARCHITECTURE 29.5, SHARED-BOUNDARIES 5.1):
//   GET  /public/v1/services | /locations | /clinicians   no authentication, audience `public`, C0 only, `max-age=60`
//   POST /webhooks/video/{vendor}, /webhooks/messaging/{vendor}   vendor signature + replay window, recorded by integration-core
// (`POST /webhooks/google/calendar` stays with calendar-sync; `GET /public/v1/clinicians/{id}/next-available` needs the definer
// function `scheduling.next_available`, which does not exist yet, and belongs to scheduling.)
// No route reads a cookie: the guard drops the header (no-cookies.ts). Nothing but GET is routed under `/public/v1`, so any other verb
// is a 404 from the router. The webhook answers `200` for a first delivery and for a duplicate (idempotent by the vendor's event ID,
// decided by integration-core's unique index), `401` for a failed verification (not recorded), `400` for a malformed one, `503` when
// the transaction or the secret store failed (the vendor retries).
import {
  Controller,
  Get,
  Param,
  Post,
  Req as ReqParam,
  Res as ResParam,
  UseGuards,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { PUBLIC } from '../../platform/permissions.js';
import { Route } from '../../platform/route.js';
import { NoCookiesGuard } from './no-cookies.js';
import type { WebhookReceiverPort } from './ports.js';
import type { PublicDirectoryService } from './public-directory.js';
import { rawBodyOf } from './raw-body.js';

export interface IntegrationsHostDeps {
  directory: PublicDirectoryService;
  receiver: WebhookReceiverPort;
  /** A failed verification is counted, not recorded (29.5). Receives only source and reason. */
  onWebhookRefused?: (info: { source: string; status: number }) => void;
}

const PUBLIC_ROUTE = { permission: PUBLIC, resolver: 'none', releaseExempt: true } as const;
const PUBLIC_CACHE = 'public, max-age=60';

const sendPublic = (res: Res, body: unknown): void => {
  res.setHeader('Cache-Control', PUBLIC_CACHE);
  res.status(200).json(body);
};

/** The status codes integration-core's receiver can return, as problem responses (the receiver stored nothing for any of them). */
function refusal(status: number): ApiError {
  switch (status) {
    case 400:
      return new ApiError(400, 'kernel.validation_failed');
    case 401:
      return new ApiError(401, 'auth.unauthenticated');
    case 404:
      return new ApiError(404, 'kernel.not_found');
    case 413:
      return new ApiError(413, 'kernel.payload_too_large');
    default:
      return new ApiError(503, 'kernel.unavailable', true);
  }
}

/** Single-valued, lower-cased headers; a repeated header is ambiguous and so counts as absent. `cookie` is never passed on. */
function headersOf(req: Req): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (name === 'cookie') continue;
    out[name] = typeof v === 'string' ? v : undefined;
  }
  return out;
}

export function createIntegrationsHostControllers(d: IntegrationsHostDeps): Type<unknown>[] {
  @Controller('public/v1')
  @UseGuards(NoCookiesGuard)
  class PublicDirectoryController {
    @Get('services')
    @Route(PUBLIC_ROUTE)
    async services(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      sendPublic(res, await d.directory.services(req.query));
    }

    @Get('locations')
    @Route(PUBLIC_ROUTE)
    async locations(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      sendPublic(res, await d.directory.locations(req.query));
    }

    @Get('clinicians')
    @Route(PUBLIC_ROUTE)
    async clinicians(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      sendPublic(res, await d.directory.clinicians(req.query));
    }
  }

  async function ingest(
    kind: 'video' | 'messaging',
    vendor: string,
    req: Req,
    res: Res,
  ): Promise<void> {
    const source = `${kind}.${vendor}`;
    const rawBody = await rawBodyOf(req);
    const r = await d.receiver.receive({ source, headers: headersOf(req), rawBody });
    if (r.status !== 200) {
      d.onWebhookRefused?.({ source: kind, status: r.status });
      throw refusal(r.status);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({});
  }

  @Controller('webhooks')
  @UseGuards(NoCookiesGuard)
  class WebhookController {
    @Post('video/:vendor')
    @Route({ ...PUBLIC_ROUTE, routeClass: 'write' })
    async video(
      @Param('vendor') vendor: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await ingest('video', vendor, req, res);
    }

    @Post('messaging/:vendor')
    @Route({ ...PUBLIC_ROUTE, routeClass: 'write' })
    async messaging(
      @Param('vendor') vendor: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await ingest('messaging', vendor, req, res);
    }
  }

  return [PublicDirectoryController, WebhookController];
}
