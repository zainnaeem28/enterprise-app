// `POST /patients/{patientId}/break-glass` (ARCHITECTURE 29.3, permission `audit.btg.open`, Idem). The guard has authenticated, checked
// CSRF, the realm, the permission and the patient named in the path by the time the handler runs; the handler opens the grant, the audit
// row and the `audit.btg_opened` event in ONE transaction under the caller's own scope (`AuditService.openBtg`). Answer: `201 {grantId,
// expiresAt}`. A reason shorter than 10 or longer than 500 characters after trimming is `422 kernel.validation_failed`.
import { randomUUID } from 'node:crypto';
import { Controller, Param, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import { AuditEnvelopeError } from '../../audit/index.js';
import type { AuditService } from '../../audit/index.js';

export interface BreakGlassControllerDeps {
  db: KernelDb;
  audit: AuditService;
}

const TEMPLATE = 'POST /patients/{patientId}/break-glass';

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

export function createBreakGlassControllers(d: BreakGlassControllerDeps): Type<unknown>[] {
  @Controller('api/v1/patients')
  class BreakGlassController {
    @Post(':patientId/break-glass')
    @Route({ permission: 'audit.btg.open', resolver: 'chart-patient' })
    async open(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      let key: string;
      try {
        key = parseIdempotencyKey(req.header('idempotency-key'));
      } catch {
        throw new ApiError(400, 'kernel.idempotency_key_required');
      }
      const b = req.body as unknown;
      const reason =
        b !== null && typeof b === 'object' && !Array.isArray(b)
          ? (b as Record<string, unknown>)['reason']
          : undefined;
      if (typeof reason !== 'string') throw new AuditEnvelopeError(['reason']);
      const pid = patientId.toLowerCase();
      const hash = requestHash({
        method: req.method,
        routeTemplate: TEMPLATE,
        pathParams: [pid],
        query: {},
        body: req.body,
      });
      const out = await d.db.withScope(
        requireAuthContext(req).scope,
        async (tx) => {
          const begun = await beginIdempotent(tx, TEMPLATE, key, hash);
          if (begun.kind === 'replay') return { kind: 'replay' as const, replay: begun.response };
          const g = await d.audit.openBtg(tx, {
            requestId: req.requestId ?? randomUUID(),
            ip: req.ip ?? null,
            userAgent: req.header('user-agent') ?? null,
            patientId: pid,
            reason,
          });
          const body = { grantId: g.grantId, expiresAt: g.expiresAt.toISOString() };
          await completeIdempotent(tx, TEMPLATE, key, {
            status: 201,
            body: Buffer.from(JSON.stringify(body)),
          });
          return { kind: 'fresh' as const, body };
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
      send(res, 201, out.body);
    }
  }
  return [BreakGlassController];
}
