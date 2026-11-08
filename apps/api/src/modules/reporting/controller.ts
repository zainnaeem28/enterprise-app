// The reporting route of ARCHITECTURE 29.4: `GET /api/v1/admin/reports/ops` {reporting.ops.read, admin realm}. The guard has authenticated
// and checked the realm and the permission by the time the handler runs; the handler opens one read transaction under the caller's scope.
import { Controller, Get, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb } from '@ehr/kernel';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import { readOpsFeed } from './feed.js';

export interface ReportingControllerDeps {
  db: KernelDb;
}

export function createReportingControllers(d: ReportingControllerDeps): Type<unknown>[] {
  @Controller('api/v1')
  class ReportingOpsController {
    @Get('admin/reports/ops')
    @Route({ permission: 'reporting.ops.read', resolver: 'none', realm: 'admin_pool' })
    async ops(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const scope = requireAuthContext(req).scope;
      const withCompliance =
        scope.phiAccess === 'limited' && (scope.complianceScopes ?? []).includes('btg_grants');
      const feed = await d.db.withScope(scope, (tx) => readOpsFeed(tx, withCompliance));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(feed);
    }
  }
  return [ReportingOpsController];
}
