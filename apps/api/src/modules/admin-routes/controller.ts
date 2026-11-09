// The audit and integration routes of ARCHITECTURE 29.4 under `staff./api/v1/admin` (realm `admin_pool`). The guard has already
// authenticated the session, checked the permission and (for †) the live elevation grant before a handler runs; the handlers
// repeat none of it. Elevation: the contract marks audit export creation, the download hand-out and the integration writes as †;
// the BTG review is elevated as well (BE-24 acceptance: "BTG review decisions are elevation-gated"), which is stricter than the
// contract row. Responses are `no-store`.
import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ScopeSettings } from '@ehr/kernel';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import type { AuditAdminService } from './audit-routes.js';
import { metaOf } from './http.js';
import type { IntegrationAdminService } from './integration-routes.js';

export interface AdminRoutesDeps {
  audit: AuditAdminService;
  integrations: IntegrationAdminService;
  /** The caller's transaction scope from the guard's authenticated context (supplied by the composition root). */
  scopeOf: (req: Req) => ScopeSettings;
  /** The caller's session ID (the export records the elevation grant it was made under). */
  sessionIdOf: (req: Req) => string;
}

const route = (permission: string, elevation = false) =>
  Route({ permission, resolver: 'none', realm: 'admin_pool', elevation });

export function createAdminRoutesControllers(d: AdminRoutesDeps): Type<unknown>[] {
  const noStore = (res: Res): void => void res.setHeader('Cache-Control', 'no-store');

  @Controller('api/v1/admin')
  class AuditAdminController {
    @Post('audit-events/search')
    @HttpCode(200)
    @route('audit.event.read')
    async search(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      return d.audit.search(d.scopeOf(req), req.body, metaOf(req));
    }

    @Post('audit-exports')
    @HttpCode(200)
    @route('audit.export.create', true)
    async createExport(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      return d.audit.requestExport(d.scopeOf(req), d.sessionIdOf(req), req.body, metaOf(req));
    }

    @Get('audit-exports/:id')
    @route('audit.export.create')
    async exportStatus(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      noStore(res);
      return d.audit.exportStatus(d.scopeOf(req), id);
    }

    @Post('audit-exports/:id/download-url')
    @HttpCode(200)
    @route('audit.export.create', true)
    async downloadUrl(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      noStore(res);
      return d.audit.downloadUrl(d.scopeOf(req), id, req.body, metaOf(req));
    }

    @Get('btg-grants')
    @route('audit.btg.review')
    async listBtg(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      return d.audit.listBtgGrants(d.scopeOf(req), req.query, metaOf(req));
    }

    @Post('btg-grants/:id/review')
    @HttpCode(200)
    @route('audit.btg.review', true)
    async reviewBtg(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      noStore(res);
      return d.audit.reviewBtg(d.scopeOf(req), id, req.body, metaOf(req));
    }
  }

  @Controller('api/v1/admin')
  class IntegrationAdminController {
    @Get('integrations')
    @route('integration.connection.read')
    async list(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      return d.integrations.list(d.scopeOf(req), req.query);
    }

    @Patch('integrations/:id')
    @HttpCode(200)
    @route('integration.connection.manage', true)
    async patch(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      noStore(res);
      const r = await d.integrations.patch(
        d.scopeOf(req),
        id,
        req.body,
        req.header('if-match'),
        metaOf(req),
      );
      res.setHeader('ETag', r.etag);
      return r.body;
    }

    @Put('integrations/:id/secrets/:name')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @route('integration.secret.write', true)
    async putSecret(@ReqParam() req: Req, @Param('id') id: string, @Param('name') name: string) {
      return d.integrations.putSecret(d.scopeOf(req), id, name, req.body, {
        ...metaOf(req),
        idempotencyKey: req.header('idempotency-key'),
      });
    }

    @Post('integrations/:id/inbound-secret-requests')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @route('integration.secret.write', true)
    async requestInbound(@ReqParam() req: Req, @Param('id') id: string) {
      return d.integrations.requestInbound(d.scopeOf(req), id, req.body, metaOf(req));
    }

    @Post('integrations/:id/inbound-secret-requests/:requestId/approve')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @route('integration.secret.approve', true)
    async approveInbound(
      @ReqParam() req: Req,
      @Param('id') id: string,
      @Param('requestId') requestId: string,
    ) {
      return d.integrations.approveInbound(d.scopeOf(req), id, requestId, req.body, metaOf(req));
    }

    @Post('integrations/:id/test')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @route('integration.connection.manage', true)
    async test(@ReqParam() req: Req, @Param('id') id: string) {
      return d.integrations.test(d.scopeOf(req), id, req.body, metaOf(req));
    }
  }

  return [AuditAdminController, IntegrationAdminController];
}
