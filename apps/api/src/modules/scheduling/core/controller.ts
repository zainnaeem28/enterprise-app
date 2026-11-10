// The patient-portal booking routes of ARCHITECTURE 29.2 that belong to the booking core: holds, confirm, cancel, reschedule and
// the two reads. Each declares {permission, resolver} (BD-07); the guard has already authenticated, checked CSRF, the realm and the
// resolver's result by the time a handler runs, and the handler opens the one transaction under the caller's scope, so row-level
// security is the second line. A reservation the caller cannot see is 404 (CN-04).
//
// The staff variants of the same paths (29.3: `scheduling.booking.manage`) are served when `hosts` is given: one controller per host,
// the patient controller bound to the patient host and the staff controller to the staff host, each with its own declaration
// (INT03-F21-O1, the pattern of the documents routes). The host only selects the declaration; the guard's realm check stays the gate.
// Without `hosts` only the unbound patient controller exists (test kits that never log in as staff). The service is realm-neutral
// (`bookedVia` and `cancelled_clinic` follow the transaction's scope).
import { Controller, Get, Param, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import type { ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import { buildAppointmentIcs } from './ics.js';
import { ReservationNotFoundError, SchedulingValidationError } from './errors.js';
import { isUuid } from './ids.js';
import type { SchedulingCoreService } from './service.js';
import type { AppointmentView, HoldInput, OccupancyStatus, RequestMeta } from './types.js';

export interface SchedulingControllerDeps {
  db: KernelDb;
  scheduling: SchedulingCoreService;
  /** The configured hosts (EHR_STAFF_HOST, EHR_PATIENT_HOST). When given, the staff variants of the booking paths are mounted (QA-EXEC-F07). */
  hosts?: { staff: string; patient: string };
}

const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const etag = (version: number): string => `W/"${version}"`;

const body = (a: AppointmentView): Record<string, unknown> => ({ ...a, patientId: a.patientId });

const BOOKING_MANAGE = 'scheduling.booking.manage';

/** The states a calendar file is served for: a hold, a cancellation or an expiry has nothing to add to a calendar. */
const ICS_STATUSES: readonly string[] = ['confirmed', 'checked_in', 'in_consultation', 'completed'];

const STATUSES: readonly string[] = [
  'held',
  'confirmed',
  'checked_in',
  'in_consultation',
  'completed',
  'cancelled_patient',
  'cancelled_clinic',
  'rescheduled',
  'no_show',
  'expired',
];

/** Resolvers (27.1): each returns the resource's patient and location when the caller's own RLS shows it, `undefined` otherwise (404). */
export function schedulingResolvers(): Record<string, ResourceResolver> {
  return {
    // body.patientId (POST /holds): the patient the booking is for; RLS (WITH CHECK) and the scope decide whether it is the caller's.
    'booking-body': (req) => {
      const p = (req.body as Record<string, unknown> | undefined)?.['patientId'];
      return Promise.resolve(isUuid(p) ? { patientId: p.toLowerCase() } : undefined);
    },
    // body.patientId and body.locationId (staff POST /holds): the location-bound permission is checked against the location named.
    'booking-body-staff': (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = b['patientId'];
      const l = b['locationId'];
      return Promise.resolve(
        isUuid(p)
          ? { patientId: p.toLowerCase(), ...(isUuid(l) ? { locationId: l.toLowerCase() } : {}) }
          : undefined,
      );
    },
    // /appointments/{id}[/...]
    reservation: async (req, _ctx, tx) => {
      const m = /\/appointments\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      if (m?.[1] === undefined || !isUuid(m[1])) return undefined;
      const r = await tx.query(
        `SELECT patient_id, location_id FROM scheduling.slot_reservation WHERE id = $1::uuid`,
        [m[1]],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : { patientId: String(row['patient_id']), locationId: String(row['location_id']) };
    },
    // /patients/{patientId}/appointments
    'booking-patient': (req) => {
      const m = /\/patients\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      return Promise.resolve(
        m?.[1] !== undefined && isUuid(m[1]) ? { patientId: m[1].toLowerCase() } : undefined,
      );
    },
  };
}

export function createSchedulingControllers(d: SchedulingControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
    reqBody: unknown,
    handler: (tx: Tx) => Promise<{ status: number; body: unknown; location?: string }>,
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
    send(res, out.fresh.status, out.fresh.body);
  }

  // The handlers, written once; the patient and the staff controller differ only in their declarations.
  const hold = async (req: Req, res: Res): Promise<void> => {
    await idempotent(req, res, 'POST /holds', [], req.body, async (tx) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const input: HoldInput = {
        patientId: b['patientId'] as string,
        serviceId: b['serviceId'] as string,
        locationId: b['locationId'] as string,
        clinicianId: b['clinicianId'] as string,
        roomId: null, // a room is assigned by the clinic, never chosen by the booker
        startsAt: b['startsAt'] as string,
        mode: b['mode'] as HoldInput['mode'],
        reason: (b['reason'] as string | null | undefined) ?? null,
        patientState: (b['patientState'] as string | null | undefined) ?? null,
        rescheduleOf: (b['rescheduleOf'] as string | null | undefined) ?? null,
      };
      const h = await d.scheduling.hold(tx, metaOf(req), input);
      return { status: 201, body: h, location: `/api/v1/appointments/${h.reservationId}` };
    });
  };

  const confirm = async (id: string, req: Req, res: Res): Promise<void> => {
    await idempotent(
      req,
      res,
      'POST /appointments/{id}/confirm',
      [id.toLowerCase()],
      req.body,
      async (tx) => ({
        status: 200,
        body: body(await d.scheduling.confirm(tx, metaOf(req), id)),
      }),
    );
  };

  const cancel = async (id: string, req: Req, res: Res): Promise<void> => {
    const expectedVersion = ifMatchVersion(req);
    await idempotent(
      req,
      res,
      'POST /appointments/{id}/cancel',
      [id.toLowerCase()],
      req.body,
      async (tx) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const a = await d.scheduling.cancel(tx, metaOf(req), id, {
          reason: (b['reason'] as string | null | undefined) ?? null,
          acceptFee: b['acceptFee'] === true,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        return { status: 200, body: body(a) };
      },
    );
  };

  const reschedule = async (id: string, req: Req, res: Res): Promise<void> => {
    const expectedVersion = ifMatchVersion(req);
    await idempotent(
      req,
      res,
      'POST /appointments/{id}/reschedule',
      [id.toLowerCase()],
      req.body,
      async (tx) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const a = await d.scheduling.reschedule(tx, metaOf(req), id, b['newHoldId'] as string, {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        return { status: 200, body: body(a) };
      },
    );
  };

  const decorate = (host?: string): ClassDecorator =>
    host === undefined ? Controller('api/v1') : Controller({ path: 'api/v1', host });

  // The inventory reads a class's own methods, so each controller is declared whole (no base class).
  const patientController = (host?: string): Type<unknown> => {
    @decorate(host)
    class PatientBookingController {
      @Post('holds')
      @Route({ permission: 'proxy', resolver: 'booking-body' })
      async hold(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
        await hold(req, res);
      }

      @Post('appointments/:id/confirm')
      @Route({ permission: 'proxy', resolver: 'reservation' })
      async confirm(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await confirm(id, req, res);
      }

      @Get('patients/:patientId/appointments')
      @Route({ permission: 'proxy', resolver: 'booking-patient' })
      async list(
        @Param('patientId') patientId: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        const status = req.query['status'];
        if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status)))
          throw new SchedulingValidationError(['status']);
        const items = await run(req, (tx) =>
          d.scheduling.list(tx, patientId, {
            ...(status === undefined ? {} : { status: status as OccupancyStatus }),
            ...(typeof req.query['from'] === 'string' ? { from: req.query['from'] } : {}),
            ...(typeof req.query['to'] === 'string' ? { to: req.query['to'] } : {}),
          }),
        );
        send(res, 200, { items: items.map(body), nextCursor: null });
      }

      @Get('appointments/:id')
      @Route({ permission: 'proxy', resolver: 'reservation' })
      async read(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        const a = await run(req, (tx) => d.scheduling.get(tx, id));
        if (a === undefined) throw new ReservationNotFoundError();
        res.setHeader('ETag', etag(a.version));
        send(res, 200, body(a));
      }

      /** The calendar file of an appointment the caller can see (RA-R1-02, BR-23): a held or cancelled one is 404, there is nothing to add. */
      @Get('appointments/:id/calendar.ics')
      @Route({ permission: 'proxy', resolver: 'reservation' })
      async ics(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        const a = await run(req, (tx) => d.scheduling.get(tx, id));
        if (a === undefined || !ICS_STATUSES.includes(a.status))
          throw new ReservationNotFoundError();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
        res.status(200).end(buildAppointmentIcs(a));
      }

      @Post('appointments/:id/cancel')
      @Route({ permission: 'proxy', resolver: 'reservation' })
      async cancel(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await cancel(id, req, res);
      }

      @Post('appointments/:id/reschedule')
      @Route({ permission: 'proxy', resolver: 'reservation' })
      async reschedule(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await reschedule(id, req, res);
      }
    }
    return PatientBookingController;
  };

  const staffController = (host: string): Type<unknown> => {
    @decorate(host)
    class StaffBookingController {
      @Post('holds')
      @Route({ permission: BOOKING_MANAGE, resolver: 'booking-body-staff' })
      async hold(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
        await hold(req, res);
      }

      @Post('appointments/:id/confirm')
      @Route({ permission: BOOKING_MANAGE, resolver: 'reservation' })
      async confirm(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await confirm(id, req, res);
      }

      @Post('appointments/:id/cancel')
      @Route({ permission: BOOKING_MANAGE, resolver: 'reservation' })
      async cancel(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await cancel(id, req, res);
      }

      @Post('appointments/:id/reschedule')
      @Route({ permission: BOOKING_MANAGE, resolver: 'reservation' })
      async reschedule(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await reschedule(id, req, res);
      }
    }
    return StaffBookingController;
  };

  const hosts = d.hosts;
  if (hosts === undefined) return [patientController()];
  if (!hosts.staff || !hosts.patient || hosts.staff.toLowerCase() === hosts.patient.toLowerCase())
    throw new Error('scheduling controllers need two distinct, non-empty staff and patient hosts');
  return [patientController(hosts.patient), staffController(hosts.staff)];
}
