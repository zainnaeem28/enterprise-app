// The merge routes of ARCHITECTURE 29.3: POST /patient-merges, GET /patient-merges/{id}, POST /patient-merges/{id}/approve and
// /reject. Each handler declares {permission, resolver} (BD-07). The guard has already authenticated, checked CSRF, the realm, the
// permission and the resolver result when a handler runs; the handler then opens one transaction under the caller's scope.
// The request needs both patients visible to the caller (a patient the caller cannot see is 404, CN-04, and audited by the guard as
// `not_visible`); approval does not (BQ-3, 9.2).
import { Controller, Get, Param, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import type { ResourceResolver } from '../../identity/index.js';
import { PatientNotFoundError } from '../errors.js';
import { isUuid } from '../ids.js';
import type { RequestMeta } from '../types.js';
import type { MergeService } from './service.js';

export interface MergeControllerDeps {
  db: KernelDb;
  merges: MergeService;
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

/** Resolvers for the routes above; register them with `identity.policy.registerResolver` (27.1). */
export function mergeResolvers(): Record<string, ResourceResolver> {
  return {
    // POST /patient-merges: both patients must be visible to the caller under its own RLS; the survivor is the patient the guard
    // then checks and audits. A missing, malformed or invisible ID is 404 with an audited `not_visible`.
    'merge-both-patients': async (req, _ctx, tx) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!isUuid(b['survivorId']) || !isUuid(b['mergedId'])) return {};
      const ids = [String(b['survivorId']).toLowerCase(), String(b['mergedId']).toLowerCase()];
      const r = await tx.query(
        `SELECT count(DISTINCT id)::int AS n FROM patient.patient WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      if (ids[0] === ids[1]) return {};
      return Number((r.rows[0] as Record<string, unknown>)['n']) === 2
        ? { patientId: ids[0] as string }
        : undefined;
    },
    // /patient-merges/{id}[/approve|/reject]: the request exists in the caller's organisation. The approver need not see the patients.
    'merge-request': async (req, _ctx, tx) => {
      const m = /\/patient-merges\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      if (m?.[1] === undefined) return undefined;
      const r = await tx.query(`SELECT 1 FROM patient.get_merge_request($1::uuid)`, [m[1]]);
      return r.rows.length === 0 ? undefined : {};
    },
  };
}

export function createMergeControllers(d: MergeControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  /** An idempotent write (28.3): the idempotency row and the business change commit together. */
  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
    handler: (tx: Tx) => Promise<{ status: number; body: unknown }>,
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

  @Controller('api/v1')
  class PatientMergeController {
    @Post('patient-merges')
    @Route({
      permission: 'patient.merge.request',
      resolver: 'merge-both-patients',
      realm: 'google',
    })
    async request(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /patient-merges', [], async (tx) => ({
        status: 200,
        body: await d.merges.request(tx, metaOf(req), req.body),
      }));
    }

    @Get('patient-merges/:id')
    @Route({ permission: 'patient.merge.request', resolver: 'merge-request', realm: 'google' })
    async get(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const v = await run(req, (tx) => d.merges.get(tx, id));
      if (v === undefined) throw new PatientNotFoundError();
      send(res, 200, v);
    }

    @Post('patient-merges/:id/approve')
    @Route({ permission: 'patient.merge.approve', resolver: 'merge-request', realm: 'google' })
    async approve(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(req, res, 'POST /patient-merges/{id}/approve', [id], async (tx) => ({
        status: 200,
        body: await d.merges.decide(tx, metaOf(req), id, 'approve'),
      }));
    }

    @Post('patient-merges/:id/reject')
    @Route({ permission: 'patient.merge.approve', resolver: 'merge-request', realm: 'google' })
    async reject(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(req, res, 'POST /patient-merges/{id}/reject', [id], async (tx) => ({
        status: 200,
        body: await d.merges.decide(tx, metaOf(req), id, 'reject'),
      }));
    }
  }

  return [PatientMergeController];
}
