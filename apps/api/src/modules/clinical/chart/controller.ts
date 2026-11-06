// The clinical chart routes of ARCHITECTURE 29.3 and 29.4. Each declares {permission, resolver} (BD-07); the guard has already
// authenticated, checked CSRF, the realm, the patient scope and (for `clinical.chart.read`) the assignment rule by the time a
// handler runs, and the handler opens the one transaction under the caller's scope, so row-level security is the second line.
//
//   GET   /patients/{id}/banner                         patient.read                 {patientBanner}, allergy part per 28.2
//   GET   /patients/{id}/chart-summary                  clinical.chart.read_previsit chart or pre-visit slice (summary.ts)
//   GET   /patients/{id}/problems|allergies|medications clinical.chart.read          banner: true
//   POST  /patients/{id}/problems|allergies|medications clinical.list.write          Idem; chart-level access re-checked
//   PATCH /patients/{id}/problems|allergies|medications/{id} clinical.list.write     If-Match
//   POST  /terminology/search                           clinical.terminology.search  <= 20 concepts
//   GET/POST /admin/vital-ranges, POST /admin/vital-ranges/{id}/retire  clinical.vital_range.manage (admin realm, elevated)
//
// Not here: `POST /check-ins/{id}/vitals` (BE-18 mounts it on `VitalsService.recordVitals`), immunisations, encounters and notes.
// `GET /patients/{id}/banner` also exists in the patient module's controller (BE-08), which cannot know the allergy part; the
// composition root registers this controller first (README, integration requests).
import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import type { AuthContext, ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import type { ChartAccess } from './access.js';
import type { BannerService } from './banner.js';
import { ChartNotFoundError } from './errors.js';
import { isUuid } from './ids.js';
import { etag, idempotentWrite, metaOf, send } from './http.js';
import type { ChartListsService } from './lists.js';
import type { ChartSummaryService } from './summary.js';
import type { TerminologyService } from './terminology.js';
import type { PatientBannerView } from './types.js';
import type { VitalsService } from './vitals.js';

export interface ChartControllerDeps {
  db: KernelDb;
  access: ChartAccess;
  banner: BannerService;
  lists: ChartListsService;
  summary: ChartSummaryService;
  terminology: TerminologyService;
  vitals: VitalsService;
}

const PATH_PATIENT = /\/patients\/([0-9a-f-]{36})(?:\/|$)/i;

/** Resolvers (27.1): the patient named in the path; the guard then checks scope and (for chart reads) the assignment. */
export function chartResolvers(): Record<string, ResourceResolver> {
  return {
    'chart-patient': (req) => {
      const m = PATH_PATIENT.exec(req.path);
      return Promise.resolve(
        m?.[1] !== undefined && isUuid(m[1]) ? { patientId: m[1].toLowerCase() } : undefined,
      );
    },
  };
}

export function createChartControllers(d: ChartControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> => {
    const ctx = requireAuthContext(req);
    return d.db.withScope(ctx.scope, (tx) => fn(tx, ctx));
  };
  const withBanner = async (
    tx: Tx,
    ctx: AuthContext,
    req: Req,
    patientId: string,
  ): Promise<PatientBannerView> => {
    const b = await d.banner.bannerFor(tx, ctx, metaOf(req), patientId);
    if (b === undefined) throw new ChartNotFoundError();
    return b;
  };
  const body = (req: Req): Record<string, unknown> => {
    const b = req.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b))
      throw new ApiError(422, 'kernel.validation_failed');
    return b as Record<string, unknown>;
  };

  @Controller('api/v1')
  class ChartReadController {
    @Get('patients/:patientId/banner')
    @Route({ permission: 'patient.read', resolver: 'chart-patient' })
    async bannerOf(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const b = await run(req, (tx, ctx) => withBanner(tx, ctx, req, id));
      send(res, 200, { patientBanner: b });
    }

    @Get('patients/:patientId/chart-summary')
    @Route({ permission: 'clinical.chart.read_previsit', resolver: 'chart-patient' })
    async chartSummary(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const s = await run(req, (tx, ctx) => d.summary.chartSummary(tx, ctx, metaOf(req), id));
      send(res, 200, s);
    }

    @Get('patients/:patientId/problems')
    @Route({ permission: 'clinical.chart.read', resolver: 'chart-patient' })
    async problems(
      @Param('patientId') id: string,
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx, ctx) => ({
        page: await d.lists.listProblems(tx, metaOf(req), id, qOf(q)),
        patientBanner: await withBanner(tx, ctx, req, id),
      }));
      send(res, 200, { ...out.page, patientBanner: out.patientBanner });
    }

    @Get('patients/:patientId/allergies')
    @Route({ permission: 'clinical.chart.read', resolver: 'chart-patient' })
    async allergies(
      @Param('patientId') id: string,
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx, ctx) => ({
        page: await d.lists.listAllergies(tx, metaOf(req), id, qOf(q)),
        patientBanner: await withBanner(tx, ctx, req, id),
      }));
      send(res, 200, { ...out.page, patientBanner: out.patientBanner });
    }

    @Get('patients/:patientId/medications')
    @Route({ permission: 'clinical.chart.read', resolver: 'chart-patient' })
    async medications(
      @Param('patientId') id: string,
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx, ctx) => ({
        page: await d.lists.listMedications(tx, metaOf(req), id, qOf(q)),
        patientBanner: await withBanner(tx, ctx, req, id),
      }));
      send(res, 200, { ...out.page, patientBanner: out.patientBanner });
    }

    @Post('terminology/search')
    @Route({ permission: 'clinical.terminology.search', resolver: 'none' })
    async terminologySearch(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const b = body(req);
      const items = await run(req, (tx) =>
        d.terminology.search(tx, { system: b['system'], text: b['text'] }),
      );
      send(res, 200, { items });
    }
  }

  /** The three list writes share one shape: chart-level access, then the service call, then the banner. */
  const write = async (
    req: Req,
    res: Res,
    template: string,
    patientId: string,
    status: number,
    fn: (tx: Tx) => Promise<{ id: string; version: number }>,
    location: (id: string) => string | undefined,
  ): Promise<void> => {
    await idempotentWrite(d.db, req, res, template, [patientId.toLowerCase()], async (tx) => {
      const ctx = requireAuthContext(req);
      await d.access.requireChart(tx, ctx, metaOf(req), patientId);
      const entry = await fn(tx);
      const loc = location(entry.id);
      return {
        status,
        body: { ...entry, patientBanner: await withBanner(tx, ctx, req, patientId) },
        ...(loc === undefined ? {} : { location: loc }),
        headers: { ETag: etag(entry.version) },
      };
    });
  };
  const patch = async <T extends { version: number }>(
    req: Req,
    res: Res,
    patientId: string,
    fn: (tx: Tx, version: number) => Promise<T>,
  ): Promise<void> => {
    const version = ifMatchVersion(req) as number;
    const out = await run(req, async (tx, ctx) => {
      await d.access.requireChart(tx, ctx, metaOf(req), patientId);
      const entry = await fn(tx, version);
      return { entry, patientBanner: await withBanner(tx, ctx, req, patientId) };
    });
    send(
      res,
      200,
      { ...out.entry, patientBanner: out.patientBanner },
      { ETag: etag(out.entry.version) },
    );
  };

  @Controller('api/v1')
  class ChartWriteController {
    @Post('patients/:patientId/problems')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async createProblem(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await write(
        req,
        res,
        'POST /patients/{patientId}/problems',
        id,
        201,
        (tx) => d.lists.createProblem(tx, metaOf(req), id, body(req)),
        (eid) => `/api/v1/patients/${id}/problems/${eid}`,
      );
    }

    @Patch('patients/:patientId/problems/:entryId')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async updateProblem(
      @Param('patientId') id: string,
      @Param('entryId') entryId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await patch(req, res, id, (tx, v) =>
        d.lists.updateProblem(tx, metaOf(req), id, entryId, v, body(req)),
      );
    }

    @Post('patients/:patientId/allergies')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async createAllergy(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await write(
        req,
        res,
        'POST /patients/{patientId}/allergies',
        id,
        201,
        (tx) => d.lists.createAllergy(tx, metaOf(req), id, body(req)),
        (eid) => `/api/v1/patients/${id}/allergies/${eid}`,
      );
    }

    @Patch('patients/:patientId/allergies/:entryId')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async updateAllergy(
      @Param('patientId') id: string,
      @Param('entryId') entryId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await patch(req, res, id, (tx, v) =>
        d.lists.updateAllergy(tx, metaOf(req), id, entryId, v, body(req)),
      );
    }

    @Post('patients/:patientId/medications')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async createMedication(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await write(
        req,
        res,
        'POST /patients/{patientId}/medications',
        id,
        201,
        (tx) => d.lists.createMedication(tx, metaOf(req), id, body(req)),
        (eid) => `/api/v1/patients/${id}/medications/${eid}`,
      );
    }

    @Patch('patients/:patientId/medications/:entryId')
    @Route({ permission: 'clinical.list.write', resolver: 'chart-patient' })
    async updateMedication(
      @Param('patientId') id: string,
      @Param('entryId') entryId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await patch(req, res, id, (tx, v) =>
        d.lists.updateMedication(tx, metaOf(req), id, entryId, v, body(req)),
      );
    }
  }

  @Controller('api/v1')
  class VitalRangeAdminController {
    @Get('admin/vital-ranges')
    @Route({ permission: 'clinical.vital_range.manage', resolver: 'none' })
    async list(
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const items = await run(req, (tx) =>
        d.vitals.listRanges(tx, typeof q['status'] === 'string' ? { status: q['status'] } : {}),
      );
      send(res, 200, { items, nextCursor: null });
    }

    @Post('admin/vital-ranges')
    @Route({ permission: 'clinical.vital_range.manage', resolver: 'none', elevation: true })
    async create(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const r = await run(req, (tx) => d.vitals.createRange(tx, metaOf(req), body(req)));
      send(res, 201, r, { Location: `/api/v1/admin/vital-ranges/${r.id}` });
    }

    @Post('admin/vital-ranges/:id/retire')
    @Route({ permission: 'clinical.vital_range.manage', resolver: 'none', elevation: true })
    async retire(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const r = await run(req, (tx) => d.vitals.retireRange(tx, metaOf(req), id));
      send(res, 200, r);
    }
  }

  return [ChartReadController, ChartWriteController, VitalRangeAdminController];
}

const qOf = (
  q: Record<string, unknown>,
): { status?: string; limit?: unknown; cursor?: unknown } => ({
  ...(typeof q['status'] === 'string' ? { status: q['status'] } : {}),
  ...(q['limit'] === undefined ? {} : { limit: q['limit'] }),
  ...(q['cursor'] === undefined ? {} : { cursor: q['cursor'] }),
});
