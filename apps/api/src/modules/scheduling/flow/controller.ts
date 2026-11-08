// The routes of the scheduling flow (ARCHITECTURE 29.2, 29.3): check-in (desk and QR), the QR token, arrivals, queue, no-show, queue
// assignment, the waitlist and its offers, and the patient's pre-visit read. Each declares {permission, resolver} (BD-07); by the time a
// handler runs the guard has authenticated, checked CSRF, the realm, the permission (location-bound roles only at their locations) and the
// resolver's result, and the handler opens the one transaction under the caller's scope, so row-level security is the second line.
// A resource the caller cannot see is 404 (CN-04).
//
// `{id}` of an appointment resolves through the booking core's `reservation` resolver (register `schedulingResolvers()` and
// `flowResolvers()` together). The staff paths and the patient paths of this file never share a path, so each has one declaration.
import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { ForbiddenError, requireAuthContext } from '../../identity/index.js';
import type { ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import { SchedulingValidationError } from '../core/errors.js';
import { isUuid } from '../core/ids.js';
import type { SchedulingFlowService } from './service.js';
import type { FlowMeta } from './types.js';

export interface FlowControllerDeps {
  db: KernelDb;
  flow: SchedulingFlowService;
}

const metaOf = (req: Req): FlowMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const etag = (version: number): string => `W/"${version}"`;

const bodyOf = (req: Req): Record<string, unknown> => {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new SchedulingValidationError(['body']);
  return b as Record<string, unknown>;
};

const pathId = (req: Req, segment: string): string | undefined => {
  const m = new RegExp(`/${segment}/([0-9a-f-]{36})(?:/|$)`, 'i').exec(req.path);
  return m?.[1] !== undefined && isUuid(m[1]) ? m[1].toLowerCase() : undefined;
};

/** Resolvers (27.1): each returns the resource's patient and place when the caller's own RLS shows it, `undefined` otherwise (404). */
export function flowResolvers(): Record<string, ResourceResolver> {
  const bySql =
    (segment: string, sql: string, withPatient: boolean, withLocation: boolean): ResourceResolver =>
    async (req, _ctx, tx) => {
      const id = pathId(req, segment);
      if (id === undefined) return undefined;
      const r = await tx.query(sql, [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        ...(withPatient ? { patientId: String(row['patient_id']) } : {}),
        ...(withLocation && row['location_id'] !== null
          ? { locationId: String(row['location_id']) }
          : {}),
      };
    };
  return {
    // /locations/{id}/...: the place; the guard then requires the grant at that place
    'flow-location': async (req, _ctx, tx) => {
      const id = pathId(req, 'locations');
      if (id === undefined) return undefined;
      const r = await tx.query(`SELECT id FROM organisation.location WHERE id = $1::uuid`, [id]);
      return r.rows.length === 0 ? undefined : { locationId: id };
    },
    // /queue-entries/{id}/stage
    'flow-queue-entry': bySql(
      'queue-entries',
      `SELECT patient_id, location_id FROM scheduling.queue_entry WHERE id = $1::uuid`,
      true,
      true,
    ),
    // /waitlist-entries/{id}
    'flow-waitlist-entry': bySql(
      'waitlist-entries',
      `SELECT patient_id, location_id FROM scheduling.waitlist_entry WHERE id = $1::uuid`,
      true,
      false,
    ),
    // /waitlist-offers/{id}/...
    'flow-offer': bySql(
      'waitlist-offers',
      `SELECT patient_id, NULL::uuid AS location_id FROM scheduling.waitlist_offer WHERE id = $1::uuid`,
      true,
      false,
    ),
    // /clinicians/{id}/schedule: the clinician is a principal, not a place. Syntactic only, no query; the same for every caller. Own-only
    // is the handler's, before it opens a transaction (decision HEAAA-286, SEC288-F06).
    'flow-clinician': (req) => {
      const id = pathId(req, 'clinicians');
      return Promise.resolve(id === undefined ? undefined : {});
    },
    // GET /waitlist?locationId=...: the place when given
    'flow-waitlist-query': async (req, _ctx, tx) => {
      const l = req.query['locationId'];
      if (l === undefined) return {};
      if (typeof l !== 'string' || !isUuid(l)) return undefined;
      const r = await tx.query(`SELECT id FROM organisation.location WHERE id = $1::uuid`, [
        l.toLowerCase(),
      ]);
      return r.rows.length === 0 ? undefined : { locationId: l.toLowerCase() };
    },
    // POST /check-ins (QR): body.reservationId, as the patient's own RLS shows it
    'flow-checkin-body': async (req, _ctx, tx) => {
      const rid = (req.body as Record<string, unknown> | undefined)?.['reservationId'];
      if (!isUuid(rid)) return undefined;
      const r = await tx.query(
        `SELECT patient_id, location_id FROM scheduling.slot_reservation WHERE id = $1::uuid`,
        [rid.toLowerCase()],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? undefined : { patientId: String(row['patient_id']) };
    },
  };
}

export function createFlowControllers(d: FlowControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
    reqBody: unknown,
    handler: (tx: Tx) => Promise<{
      status: number;
      body: unknown;
      location?: string;
      headers?: Record<string, string>;
    }>,
  ): Promise<void> {
    let key: string;
    try {
      key = parseIdempotencyKey(req.header('idempotency-key'));
    } catch {
      throw new ApiError(400, 'kernel.idempotency_key_required');
    }
    const hash = requestHash({
      method: req.method,
      routeTemplate: template,
      pathParams,
      query: {},
      body: reqBody,
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
          ...(fresh.location === undefined ? {} : { location: fresh.location }),
        });
        return { kind: 'fresh' as const, fresh };
      },
      { idempotent: true },
    );
    if (out.kind === 'replay') {
      const r = out.replay;
      res.setHeader('Idempotent-Replay', 'true');
      if (r.location !== null) res.setHeader('Location', r.location);
      send(res, r.status, r.body === null ? {} : JSON.parse(r.body.toString('utf8')));
      return;
    }
    if (out.fresh.location !== undefined) res.setHeader('Location', out.fresh.location);
    for (const [k, v] of Object.entries(out.fresh.headers ?? {})) res.setHeader(k, v);
    send(res, out.fresh.status, out.fresh.body);
  }

  @Controller('api/v1')
  class StaffFlowController {
    @Post('appointments/:id/check-in')
    @Route({ permission: 'scheduling.check_in', resolver: 'reservation' })
    async checkIn(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req) as number;
      await idempotent(
        req,
        res,
        'POST /appointments/{id}/check-in',
        [id.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.checkIn(tx, metaOf(req), id, { method: 'desk', expectedVersion }),
        }),
      );
    }

    @Post('appointments/:id/no-show')
    @Route({ permission: 'scheduling.check_in', resolver: 'reservation' })
    async noShow(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req) as number;
      await idempotent(
        req,
        res,
        'POST /appointments/{id}/no-show',
        [id.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.markNoShow(tx, metaOf(req), id, expectedVersion),
        }),
      );
    }

    @Put('appointments/:id/assignment')
    @Route({ permission: 'scheduling.queue.manage', resolver: 'reservation' })
    async assign(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req) as number;
      const b = bodyOf(req);
      const e = await run(req, (tx) =>
        d.flow.assign(
          tx,
          metaOf(req),
          id,
          {
            ...('clinicianId' in b ? { clinicianId: b['clinicianId'] as string | null } : {}),
            ...('roomId' in b ? { roomId: b['roomId'] as string | null } : {}),
          },
          expectedVersion,
        ),
      );
      res.setHeader('ETag', etag(e.version));
      send(res, 200, e);
    }

    @Get('clinicians/:id/schedule')
    @Route({ permission: 'scheduling.booking.own_schedule', resolver: 'flow-clinician' })
    async schedule(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const ctx = requireAuthContext(req);
      // Own-only, and the grant at the named location, both before any transaction or query; one refusal for every case.
      const loc = req.query['locationId'];
      const date = req.query['date'];
      const mine = ctx.session.principalId.toLowerCase() === id.toLowerCase();
      const granted =
        typeof loc === 'string' && isUuid(loc)
          ? ctx.grants.has('scheduling.booking.own_schedule', loc.toLowerCase())
          : true;
      if (!mine || !granted) {
        await d.flow.audit.recordDenied(d.db, ctx.scope, {
          requestId: req.requestId ?? null,
          resourceType: 'scheduling.route',
          denialReason: 'forbidden',
          ip: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        });
        throw new ForbiddenError();
      }
      if (typeof loc !== 'string' || !isUuid(loc))
        throw new SchedulingValidationError(['locationId']);
      if (date !== undefined && typeof date !== 'string')
        throw new SchedulingValidationError(['date']);
      send(
        res,
        200,
        await run(req, (tx) => d.flow.clinicianSchedule(tx, metaOf(req), id, loc, date)),
      );
    }

    @Get('locations/:locationId/arrivals')
    @Route({ permission: 'scheduling.check_in', resolver: 'flow-location' })
    async arrivals(
      @Param('locationId') locationId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const date = req.query['date'];
      if (date !== undefined && typeof date !== 'string')
        throw new SchedulingValidationError(['date']);
      const items = await run(req, (tx) => d.flow.arrivals(tx, locationId, date));
      send(res, 200, { items, nextCursor: null });
    }

    @Get('locations/:locationId/check-in-qr')
    @Route({ permission: 'scheduling.check_in', resolver: 'flow-location' })
    async qr(
      @Param('locationId') locationId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, await run(req, (tx) => d.flow.qrForToday(tx, locationId)));
    }

    @Get('locations/:locationId/queue')
    @Route({ permission: 'scheduling.queue.manage', resolver: 'flow-location' })
    async queue(
      @Param('locationId') locationId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const items = await run(req, (tx) => d.flow.queue(tx, locationId));
      send(res, 200, { items, nextCursor: null });
    }

    @Put('queue-entries/:id/stage')
    @Route({ permission: 'scheduling.queue.manage', resolver: 'flow-queue-entry' })
    async stage(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req) as number;
      const b = bodyOf(req);
      const e = await run(req, (tx) =>
        d.flow.setStage(tx, metaOf(req), id, b['stage'], expectedVersion),
      );
      res.setHeader('ETag', etag(e.version));
      send(res, 200, e);
    }

    @Get('waitlist')
    @Route({ permission: 'scheduling.waitlist.manage', resolver: 'flow-waitlist-query' })
    async waitlist(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const q = (k: string): string | undefined => {
        const v = req.query[k];
        if (v === undefined) return undefined;
        if (typeof v !== 'string') throw new SchedulingValidationError([k]);
        return v;
      };
      const serviceId = q('serviceId');
      const locationId = q('locationId');
      const items = await run(req, (tx) =>
        d.flow.waitlist.listForStaff(tx, {
          ...(serviceId === undefined ? {} : { serviceId }),
          ...(locationId === undefined ? {} : { locationId }),
        }),
      );
      send(res, 200, { items, nextCursor: null });
    }
  }

  @Controller('api/v1')
  class PatientFlowController {
    @Post('check-ins')
    @Route({ permission: 'patient', resolver: 'flow-checkin-body' })
    async checkIn(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const b = bodyOf(req);
      if (!isUuid(b['reservationId'])) throw new SchedulingValidationError(['reservationId']);
      const id = b['reservationId'].toLowerCase();
      await idempotent(req, res, 'POST /check-ins', [], req.body, async (tx) => ({
        status: 200,
        body: await d.flow.checkIn(tx, metaOf(req), id, {
          method: 'qr',
          ...(typeof b['qrToken'] === 'string' ? { qrToken: b['qrToken'] } : {}),
        }),
      }));
    }

    // `proxy`, not `patient`: a proxy reaches the service, which answers `requiredConsents: null` (D-7), instead of the guard's 404.
    @Get('appointments/:id/previsit')
    @Route({ permission: 'proxy', resolver: 'reservation' })
    async previsit(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, await run(req, (tx) => d.flow.previsitFor(tx, id)));
    }

    // `proxy` only so that the service can answer a proxy with 403 auth.forbidden (D-7) as decided; the guard would answer 404.
    @Post('appointments/:id/previsit/consents')
    @Route({ permission: 'proxy', resolver: 'reservation' })
    async openConsents(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      if (Object.keys(bodyOf(req)).length > 0) throw new SchedulingValidationError(['body']);
      await idempotent(
        req,
        res,
        'POST /appointments/{reservationId}/previsit/consents',
        [id.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.openPrevisitConsents(tx, metaOf(req), id),
        }),
      );
    }

    @Post('waitlist-entries')
    @Route({ permission: 'proxy', resolver: 'booking-body' })
    async createEntry(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /waitlist-entries', [], req.body, async (tx) => {
        const b = bodyOf(req);
        const e = await d.flow.waitlist.createEntry(tx, metaOf(req), {
          patientId: b['patientId'] as string,
          serviceId: b['serviceId'] as string,
          locationId: (b['locationId'] as string | null | undefined) ?? null,
          clinicianId: (b['clinicianId'] as string | null | undefined) ?? null,
          from: b['from'] as string,
          to: b['to'] as string,
        });
        return { status: 201, body: e, location: `/api/v1/waitlist-entries/${e.id}` };
      });
    }

    @Delete('waitlist-entries/:id')
    @Route({ permission: 'proxy', resolver: 'flow-waitlist-entry' })
    async cancelEntry(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'DELETE /waitlist-entries/{id}',
        [id.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.waitlist.cancelEntry(tx, metaOf(req), id),
        }),
      );
    }

    @Post('waitlist-offers/:offerId/accept')
    @Route({ permission: 'proxy', resolver: 'flow-offer' })
    async accept(
      @Param('offerId') offerId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /waitlist-offers/{offerId}/accept',
        [offerId.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.waitlist.acceptOffer(tx, metaOf(req), offerId),
        }),
      );
    }

    @Post('waitlist-offers/:offerId/decline')
    @Route({ permission: 'proxy', resolver: 'flow-offer' })
    async decline(
      @Param('offerId') offerId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /waitlist-offers/{offerId}/decline',
        [offerId.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 200,
          body: await d.flow.waitlist.declineOffer(tx, metaOf(req), offerId),
        }),
      );
    }
  }

  return [StaffFlowController, PatientFlowController];
}
