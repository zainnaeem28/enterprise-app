// The routes of telehealth (ARCHITECTURE 29.2, 29.3). Each declares {permission, resolver} (BD-07); by the time a handler runs the guard
// has authenticated, checked CSRF, the realm, the permission and the resolver's result (`reservation`, registered by the booking core), and
// the handler opens the transaction under the caller's own scope, so row-level security is the second line. A visit the caller cannot
// see is 404 (CN-04).
//
//   patient host (`my.`, realm patient, patient or proxy)
//     GET  /appointments/{id}/video-session              status, admission, joinOpensAt, needsLocationConfirmation  (passive, 26.2)
//     POST /appointments/{id}/video-session/device-check pass or fail per device
//     POST /appointments/{id}/video-session/location     {state}; 422 telehealth.licensing_refused
//     POST /appointments/{id}/video-session/join         {vendor, meetingId, attendeeToken}, once admitted
//   staff host (`staff.`, google realm, telehealth.session.host)
//     POST /appointments/{id}/video-session/admit        the waiting room
//     POST /appointments/{id}/video-session/end
//     GET  /appointments/{id}/video-session/host         DEPARTURE D1: the catalogue puts the staff GET and join on the PATIENT paths
//     POST /appointments/{id}/video-session/host/join    (same method and path, two realms). The route platform has one declaration per
//                                                        method and path, so the two staff routes carry `/host`. See the README.
import { randomUUID } from 'node:crypto';
import { Controller, Get, Param, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import { TelehealthValidationError } from './errors.js';
import { TelehealthService } from './service.js';
import type { TelehealthMeta } from './types.js';

export interface TelehealthControllerDeps {
  db: KernelDb;
  telehealth: TelehealthService;
}

const metaOf = (req: Req): TelehealthMeta => ({
  requestId: req.requestId ?? randomUUID(),
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const bodyOf = (req: Req): Record<string, unknown> => {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new TelehealthValidationError(['body']);
  return b as Record<string, unknown>;
};

/** The key is required on every Idem route (400 `kernel.idempotency_key_required`). */
function keyOf(req: Req): string {
  try {
    return parseIdempotencyKey(req.header('idempotency-key'));
  } catch {
    throw new ApiError(400, 'kernel.idempotency_key_required');
  }
}

export function createTelehealthControllers(d: TelehealthControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  /** Stored-response idempotency for the routes whose answer is safe to replay (a host's view). */
  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
    handler: (tx: Tx) => Promise<{ status: number; body: unknown }>,
  ): Promise<void> {
    const key = keyOf(req);
    const hash = requestHash({
      method: req.method,
      routeTemplate: template,
      pathParams,
      query: {},
      body: req.body,
    });
    const out = await d.db.withScope(
      requireAuthContext(req).scope,
      async (tx) => {
        const begun = await beginIdempotent(tx, template, key, hash);
        if (begun.kind === 'replay') return { kind: 'replay' as const, replay: begun.response };
        const fresh = await handler(tx);
        await completeIdempotent(tx, template, key, {
          status: fresh.status,
          body: Buffer.from(JSON.stringify(fresh.body)),
        });
        return { kind: 'fresh' as const, fresh };
      },
      { idempotent: true },
    );
    if (out.kind === 'replay') {
      res.setHeader('Idempotent-Replay', 'true');
      send(
        res,
        out.replay.status,
        out.replay.body === null ? {} : JSON.parse(out.replay.body.toString('utf8')),
      );
      return;
    }
    send(res, out.fresh.status, out.fresh.body);
  }

  @Controller('api/v1/appointments')
  class PatientTelehealthController {
    @Get(':id/video-session')
    @Route({ permission: 'proxy', resolver: 'reservation', routeClass: 'read' })
    async status(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, await run(req, (tx) => d.telehealth.patientView(tx, id)));
    }

    @Post(':id/video-session/device-check')
    @Route({ permission: 'patient', resolver: 'reservation' })
    async deviceCheck(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, (tx) => d.telehealth.deviceCheck(tx, metaOf(req), id, req.body));
      send(res, 200, out);
    }

    // The answer is kept (one K row per attempt) even when it is a refusal, so this commits first and refuses after. No stored response:
    // a replay is a fresh attempt with its own row.
    @Post(':id/video-session/location')
    @Route({ permission: 'patient', resolver: 'reservation' })
    async location(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      keyOf(req);
      const o = await run(req, (tx) =>
        d.telehealth.confirmLocation(tx, metaOf(req), id, bodyOf(req)),
      );
      TelehealthService.assertAllowed(o);
      send(res, 200, { result: o.result, flagged: o.flagged });
    }

    // The vendor token is a bearer credential: it is never put in the idempotency record. A repeated key gets a fresh single-use token and
    // the earlier one is superseded.
    @Post(':id/video-session/join')
    @Route({ permission: 'proxy', resolver: 'reservation' })
    async join(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      keyOf(req);
      send(res, 200, await d.telehealth.join(requireAuthContext(req).scope, metaOf(req), id));
    }
  }

  @Controller('api/v1/appointments')
  class HostTelehealthController {
    @Get(':id/video-session/host')
    @Route({
      permission: 'telehealth.session.host',
      resolver: 'reservation',
      realm: 'google',
      routeClass: 'read',
    })
    async view(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      send(res, 200, await run(req, (tx) => d.telehealth.hostView(tx, id)));
    }

    @Post(':id/video-session/host/join')
    @Route({ permission: 'telehealth.session.host', resolver: 'reservation', realm: 'google' })
    async join(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      keyOf(req);
      send(res, 200, await d.telehealth.join(requireAuthContext(req).scope, metaOf(req), id));
    }

    @Post(':id/video-session/admit')
    @Route({ permission: 'telehealth.session.host', resolver: 'reservation', realm: 'google' })
    async admit(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /appointments/{id}/video-session/admit',
        [id.toLowerCase()],
        async (tx) => ({
          status: 200,
          body: await d.telehealth.admit(tx, metaOf(req), id, bodyOf(req)),
        }),
      );
    }

    @Post(':id/video-session/end')
    @Route({ permission: 'telehealth.session.host', resolver: 'reservation', realm: 'google' })
    async end(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /appointments/{id}/video-session/end',
        [id.toLowerCase()],
        async (tx) => {
          const r = await d.telehealth.end(tx, metaOf(req), id);
          return { status: 200, body: r.view };
        },
      );
    }
  }

  return [PatientTelehealthController, HostTelehealthController];
}
