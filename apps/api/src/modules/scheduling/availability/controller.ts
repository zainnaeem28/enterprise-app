// The availability routes of ARCHITECTURE 29.2, 29.3 and 29.4: slot search, a doctor's templates, leave and blocked time, and the roster.
// Each declares {permission, resolver} (BD-07); by the time a handler runs the guard has authenticated, checked CSRF, the realm and the
// permission (location-bound roles only at their locations), and the handler opens the one transaction under the caller's scope, so
// row-level security is the second line. The staff routes and the admin routes (`/admin/...`, realm admin_pool, elevation by the
// permission catalogue) are the same handlers under two prefixes.
//
// Own-only (29.3): on the staff routes {id} must be the session's own principal. The resolver cannot say 403 (it can only say 404), so
// the handler does: it writes the `denied` audit event and answers 403 auth.forbidden; the service and the policy check it again.
//
// `POST /availability/search` exists on both portals (29.2 patient, 29.3 `scheduling.availability.search`). The framework has one handler
// per path and the guard derives a route's realm from its permission, so the route is declared for any session (`realm: 'none'`) and the
// handler decides: a patient session, or a google-realm staff session holding the permission; everything else is 403.
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
import { PUBLIC } from '../../../platform/permissions.js';
import { Route } from '../../../platform/route.js';
import type { AuditService } from '../../audit/index.js';
import { ForbiddenError, requireAuthContext } from '../../identity/index.js';
import type { ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import { isUuid } from '../core/ids.js';
import type { RequestMeta } from '../core/types.js';
import { SchedulingValidationError } from './errors.js';
import type { AvailabilitySearch } from './search.js';
import type { AvailabilityService } from './service.js';
import type {
  BlockedTimeInput,
  BlockedTimeView,
  ConflictCounts,
  RosterInput,
  RosterView,
  SearchInput,
  TemplateInput,
  TemplateView,
} from './types.js';

export interface AvailabilityControllerDeps {
  db: KernelDb;
  audit: AuditService;
  availability: AvailabilityService;
  search: AvailabilitySearch;
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
const asBody = (req: Req): Record<string, unknown> => {
  const b = req.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b))
    throw new SchedulingValidationError(['body']);
  return b as Record<string, unknown>;
};
const templateBody = (t: TemplateView): Record<string, unknown> => ({ ...t });

/** Resolvers (27.1): the resource must exist in the caller's view; the guard then checks the location grant where there is one. */
export function availabilityResolvers(): Record<string, ResourceResolver> {
  return {
    // /clinicians/{id}/... and /admin/clinicians/{id}/...: the doctor is a principal, not a place; own-only is the handler's.
    'availability-clinician': (req) => {
      const m = /\/clinicians\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      return Promise.resolve(m?.[1] !== undefined && isUuid(m[1]) ? {} : undefined);
    },
    // /locations/{id}/roster and /admin/locations/{id}/roster: the place (the guard then requires the grant at that place).
    'availability-location': async (req, _ctx, tx) => {
      const m = /\/locations\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      if (m?.[1] === undefined || !isUuid(m[1])) return undefined;
      const r = await tx.query(`SELECT id FROM organisation.location WHERE id = $1::uuid`, [
        m[1].toLowerCase(),
      ]);
      return r.rows.length === 0 ? undefined : { locationId: m[1].toLowerCase() };
    },
  };
}

export function createAvailabilityControllers(d: AvailabilityControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  /** Own-only on the staff routes: another doctor's ID is audited and refused before any transaction. */
  async function ownOnly(req: Req, clinicianId: string): Promise<void> {
    const ctx = requireAuthContext(req);
    if (ctx.session.realm !== 'google') return; // the admin realm manages every clinician
    if (ctx.session.principalId.toLowerCase() === clinicianId.toLowerCase()) return;
    await d.audit.recordDenied(d.db, ctx.scope, {
      requestId: req.requestId ?? null,
      resourceType: 'scheduling.route',
      denialReason: 'forbidden',
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    throw new ForbiddenError();
  }

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

  // One set of handlers per prefix: `/api/v1` (staff, realm google, own-only) and `/api/v1/admin` (admin_pool, any clinician).
  function management(prefix: string, own: boolean): Type<unknown> {
    const tag = own ? 'staff' : 'admin';
    const guardOwn = async (req: Req, id: string): Promise<void> => {
      if (own) await ownOnly(req, id);
    };

    @Controller(prefix)
    class ManagementController {
      // ----- templates ---------------------------------------------------------------------------------------------
      @Get('clinicians/:id/availability-templates')
      @Route({ permission: 'scheduling.template.manage', resolver: 'availability-clinician' })
      async listTemplates(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        const status = req.query['status'];
        if (status !== undefined && status !== 'active' && status !== 'retired')
          throw new SchedulingValidationError(['status']);
        const items = await run(req, (tx) =>
          d.availability.listTemplates(tx, id, status === undefined ? {} : { status }),
        );
        send(res, 200, { items: items.map(templateBody), nextCursor: null });
      }

      @Post('clinicians/:id/availability-templates')
      @Route({ permission: 'scheduling.template.manage', resolver: 'availability-clinician' })
      async createTemplate(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        await idempotent(
          req,
          res,
          `POST ${prefix}/clinicians/{id}/availability-templates`,
          [id.toLowerCase()],
          req.body,
          async (tx) => {
            const t = await d.availability.createTemplate(
              tx,
              metaOf(req),
              id,
              asBody(req) as unknown as TemplateInput,
            );
            return {
              status: 201,
              body: templateBody(t),
              location: `${prefix}/clinicians/${t.clinicianId}/availability-templates/${t.id}`,
              headers: { ETag: etag(t.version) },
            };
          },
        );
      }

      @Put('clinicians/:id/availability-templates/:templateId')
      @Route({ permission: 'scheduling.template.manage', resolver: 'availability-clinician' })
      async replaceTemplate(
        @Param('id') id: string,
        @Param('templateId') templateId: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        const version = ifMatchVersion(req) as number;
        const t = await run(req, (tx) =>
          d.availability.replaceTemplate(
            tx,
            metaOf(req),
            id,
            templateId,
            asBody(req) as unknown as TemplateInput,
            version,
          ),
        );
        res.setHeader('ETag', etag(t.version));
        send(res, 200, templateBody(t));
      }

      @Delete('clinicians/:id/availability-templates/:templateId')
      @Route({ permission: 'scheduling.template.manage', resolver: 'availability-clinician' })
      async retireTemplate(
        @Param('id') id: string,
        @Param('templateId') templateId: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        const version = ifMatchVersion(req) as number;
        const t = await run(req, (tx) =>
          d.availability.retireTemplate(tx, metaOf(req), id, templateId, version),
        );
        res.setHeader('ETag', etag(t.version));
        send(res, 200, templateBody(t));
      }

      // ----- leave and blocked time -----------------------------------------------------------------------------------
      @Get('clinicians/:id/blocked-times')
      @Route({ permission: 'scheduling.blocked_time.manage', resolver: 'availability-clinician' })
      async listBlocked(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        const items = await run(req, (tx) =>
          d.availability.listBlockedTimes(tx, id, {
            ...(typeof req.query['from'] === 'string' ? { from: req.query['from'] } : {}),
            ...(typeof req.query['to'] === 'string' ? { to: req.query['to'] } : {}),
          }),
        );
        send(res, 200, { items: items.map((b: BlockedTimeView) => ({ ...b })), nextCursor: null });
      }

      @Post('clinicians/:id/blocked-times')
      @Route({ permission: 'scheduling.blocked_time.manage', resolver: 'availability-clinician' })
      async createBlocked(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        await idempotent(
          req,
          res,
          `POST ${prefix}/clinicians/{id}/blocked-times`,
          [id.toLowerCase()],
          req.body,
          async (tx) => {
            const r = await d.availability.createBlockedTime(
              tx,
              metaOf(req),
              id,
              asBody(req) as unknown as BlockedTimeInput,
            );
            const conflicts: ConflictCounts = r.conflicts;
            // A dry run saves nothing: 200 with the counts the caller must acknowledge (counts only, 29.3).
            return r.blockedTime === undefined
              ? { status: 200, body: { saved: false, conflicts } }
              : {
                  status: 201,
                  body: { ...r.blockedTime, saved: true, conflicts },
                  location: `${prefix}/clinicians/${r.blockedTime.clinicianId}/blocked-times/${r.blockedTime.id}`,
                };
          },
        );
      }

      @Delete('clinicians/:id/blocked-times/:blockedId')
      @Route({ permission: 'scheduling.blocked_time.manage', resolver: 'availability-clinician' })
      async deleteBlocked(
        @Param('id') id: string,
        @Param('blockedId') blockedId: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await guardOwn(req, id);
        await run(req, (tx) => d.availability.deleteBlockedTime(tx, metaOf(req), id, blockedId));
        res.status(204).end();
      }

      // ----- roster ----------------------------------------------------------------------------------------------------
      @Get('locations/:id/roster')
      @Route({ permission: 'scheduling.roster.manage', resolver: 'availability-location' })
      async listRoster(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        const items = await run(req, (tx) =>
          d.availability.listRoster(tx, id, {
            ...(typeof req.query['from'] === 'string' ? { from: req.query['from'] } : {}),
            ...(typeof req.query['to'] === 'string' ? { to: req.query['to'] } : {}),
          }),
        );
        send(res, 200, { items: items.map((r: RosterView) => ({ ...r })), nextCursor: null });
      }

      @Post('locations/:id/roster')
      @Route({ permission: 'scheduling.roster.manage', resolver: 'availability-location' })
      async addRoster(
        @Param('id') id: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await idempotent(
          req,
          res,
          `POST ${prefix}/locations/{id}/roster`,
          [id.toLowerCase()],
          req.body,
          async (tx) => {
            const r = await d.availability.addRoster(
              tx,
              metaOf(req),
              id,
              asBody(req) as unknown as RosterInput,
            );
            return {
              status: 201,
              body: { ...r },
              location: `${prefix}/locations/${r.locationId}/roster/${r.id}`,
            };
          },
        );
      }

      @Delete('locations/:id/roster/:entryId')
      @Route({ permission: 'scheduling.roster.manage', resolver: 'availability-location' })
      async deleteRoster(
        @Param('id') id: string,
        @Param('entryId') entryId: string,
        @ReqParam() req: Req,
        @ResParam() res: Res,
      ): Promise<void> {
        await run(req, (tx) => d.availability.deleteRoster(tx, metaOf(req), id, entryId));
        res.status(204).end();
      }
    }
    Object.defineProperty(ManagementController, 'name', { value: `${tag}AvailabilityController` });
    return ManagementController;
  }

  @Controller('api/v1')
  class SearchController {
    @Post('availability/search')
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'none' })
    async search(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const ctx = requireAuthContext(req);
      const patient = ctx.session.realm === 'patient_pool';
      const staff =
        ctx.session.realm === 'google' && ctx.grants.has('scheduling.availability.search');
      if (!patient && !staff) throw new ForbiddenError();
      const r = await run(req, (tx) => d.search.search(tx, asBody(req) as unknown as SearchInput));
      send(res, 200, r);
    }
  }

  return [management('api/v1', true), management('api/v1/admin', false), SearchController];
}
