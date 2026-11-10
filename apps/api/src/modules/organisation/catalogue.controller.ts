// The patient-audience catalogue reads of ARCHITECTURE 29.2 / 22.5.1: `GET /api/v1/services` and `GET /api/v1/locations`. They return
// the C0 directory rows (neutral service names, no internal name, no inactive rows) through the organisation module's directory
// readers, i.e. the nine views of 22.5.1, never a base table. The guard has already authenticated the caller in the patient realm
// (`patient` capability, no resource); the handler opens one read-only transaction under the caller's own scope, so RLS is the
// second line. The anonymous twin is `/public/v1/*` (integrations-host). The whole directory is returned with `nextCursor: null`
// (a clinic's catalogue is small; the CN-08 cursor is not issued).
import { Controller, Get, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { PUBLIC } from '../../platform/permissions.js';
import { Route } from '../../platform/route.js';
import { OrganisationValidationError } from './errors.js';
import type { OrganisationService } from './service.js';

export interface CatalogueControllerDeps {
  db: KernelDb;
  organisation: Pick<
    OrganisationService,
    'directoryLocations' | 'directoryServices' | 'currentBanners'
  >;
  /** The caller's transaction scope, from the guard's authenticated context (supplied by the composition root: organisation sits below identity). */
  scopeOf: (req: Req) => ScopeSettings;
}

const ROUTE = { permission: 'patient', resolver: 'none' } as const;

export function createCatalogueControllers(d: CatalogueControllerDeps): Type<unknown>[] {
  const scopeOf = d.scopeOf;
  const read = async <T>(req: Req, res: Res, fn: (tx: Tx) => Promise<T>): Promise<void> => {
    const items = await d.db.withScope(
      scopeOf(req),
      async (tx) => {
        await tx.query('SET LOCAL transaction_read_only = on');
        return fn(tx);
      },
      { idempotent: true },
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ items, nextCursor: null });
  };

  @Controller('api/v1')
  class CatalogueController {
    @Get('services')
    @Route(ROUTE)
    async services(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const loc = req.query['locationId'];
      if (loc !== undefined && typeof loc !== 'string')
        throw new ApiError(400, 'kernel.validation_failed', false, {
          errors: [{ path: '/locationId', code: 'kernel.invalid_format' }],
        });
      try {
        await read(req, res, (tx) =>
          d.organisation.directoryServices(tx, loc === undefined ? {} : { locationId: loc }),
        );
      } catch (e) {
        if (e instanceof OrganisationValidationError)
          throw new ApiError(400, 'kernel.validation_failed', false, {
            errors: [{ path: '/locationId', code: 'kernel.invalid_format' }],
          });
        throw e;
      }
    }

    @Get('locations')
    @Route(ROUTE)
    async locations(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await read(req, res, (tx) => d.organisation.directoryLocations(tx));
    }

    /**
     * Amendment A-8 (QA-EXEC-F09): current maintenance banners of the caller's portal. Any session on the portal hosts; the surface
     * comes from the session audience, never from the request.
     */
    @Get('banners')
    @Route({ permission: PUBLIC, resolver: 'session', realm: ['patient', 'google', 'admin_pool'] })
    async banners(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      for (const k of Object.keys(req.query))
        throw new ApiError(400, 'kernel.validation_failed', false, {
          errors: [{ path: `/${k}`, code: 'kernel.unknown_field' }],
        });
      const scope = scopeOf(req);
      const surface =
        scope.audience === 'patient' ? 'patient' : scope.audience === 'staff' ? 'staff' : null;
      if (surface === null) throw new ApiError(403, 'auth.forbidden');
      await read(req, res, (tx) => d.organisation.currentBanners(tx, surface));
    }
  }
  return [CatalogueController];
}
