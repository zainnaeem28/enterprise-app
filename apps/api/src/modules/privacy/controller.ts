// The privacy routes of ARCHITECTURE 29.2, 29.3 and 29.4. Each declares {permission, resolver} (BD-07); the guard has already
// authenticated, checked CSRF, the realm and the resolver's result by the time a handler runs, and the handler opens the one
// transaction under the caller's scope, so row-level security is the second line and the triggers the third.
//
//   POST /privacy-requests                               patient    Idem; {kind, detail?}; a deletion request is stored blocked_d8 (D-8)
//   GET  /privacy-requests, /privacy-requests/{id}       patient    own only; another patient's is 404 (TC-PR-04)
//   POST /privacy-requests/{id}/export/download-url      patient    409 privacy.export_not_ready; audited `export`
//   POST /patients/{patientId}/privacy-requests          privacy.request.create_for_patient   Idem; create only
//   GET  /admin/privacy-requests                         privacy.request.manage   metadata only, never content (6.7)
//   POST /admin/privacy-requests/{id}/verify-identity    privacy.request.manage   {method}
//   POST /admin/privacy-requests/{id}/decide             privacy.request.manage   {decision: approve|refuse|retry|fulfil, reason?}
//   GET/POST/PATCH /admin/incidents                      privacy.incident.manage  PATCH carries the incident `id` in its body (If-Match)
import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import type { ResourceResolver } from '../identity/index.js';
import { ifMatchVersion } from '../patient/index.js';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import { PrivacyValidationError } from './errors.js';
import { isUuid } from './ids.js';
import type { IncidentService } from './incidents.js';
import type { PackageService } from './packages.js';
import type { RequestService } from './requests.js';
import type { RequestMeta } from './types.js';

export interface PrivacyControllerDeps {
  db: KernelDb;
  requests: RequestService;
  packages: PackageService;
  incidents: IncidentService;
}

const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (
  res: Res,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const etag = (version: number): string => `W/"${version}"`;

const UUID_IN_PATH = (path: string, segment: string): string | undefined => {
  const m = new RegExp(`/${segment}/([0-9a-f-]{36})(?:/|$)`, 'i').exec(path);
  return m?.[1] !== undefined && isUuid(m[1]) ? m[1].toLowerCase() : undefined;
};

const bodyOf = (req: Req): Record<string, unknown> => {
  const b = req.body;
  if (b === undefined || b === null || typeof b !== 'object' || Array.isArray(b))
    throw new PrivacyValidationError(['body']);
  return b as Record<string, unknown>;
};

const limitOf = (req: Req): number | undefined => {
  const q = req.query?.['limit'];
  if (q === undefined) return undefined;
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new PrivacyValidationError(['limit']);
  return n;
};
const cursorOf = (req: Req): string | undefined => {
  const q = req.query?.['cursor'];
  if (q === undefined) return undefined;
  if (typeof q !== 'string' || q.length > 200) throw new PrivacyValidationError(['cursor']);
  return q;
};

/** Resolvers (27.1): each returns the resource's patient when the caller's own RLS shows it, `undefined` otherwise (404). */
export function privacyResolvers(): Record<string, ResourceResolver> {
  return {
    // /patients/{patientId}/privacy-requests (staff: the guard checks the patient is in the caller's scope)
    'privacy-patient': (req) => {
      const id = UUID_IN_PATH(req.path, 'patients');
      return Promise.resolve(id === undefined ? undefined : { patientId: id });
    },
    // /privacy-requests/{id}[/...] (patient: the request must be the caller's own)
    'privacy-request': async (req, _ctx, tx) => {
      const id = UUID_IN_PATH(req.path, 'privacy-requests');
      if (id === undefined) return undefined;
      const r = await tx.query(`SELECT patient_id FROM privacy.request WHERE id = $1::uuid`, [id]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? undefined : { patientId: String(row['patient_id']) };
    },
  };
}

export function createPrivacyControllers(d: PrivacyControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>, retryable = false): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn, retryable ? { idempotent: true } : undefined);

  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
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

  @Controller('api/v1')
  class PrivacyPatientController {
    @Post('privacy-requests')
    @Route({ permission: 'patient', resolver: 'none' })
    async create(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /privacy-requests', [], async (tx) => {
        const v = await d.requests.createOwn(tx, metaOf(req), bodyOf(req));
        return { status: 201, body: v, location: `/api/v1/privacy-requests/${v.id}` };
      });
    }

    @Get('privacy-requests')
    @Route({ permission: 'patient', resolver: 'none' })
    async list(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const items = await run(req, (tx) => d.requests.listOwn(tx));
      send(res, 200, { items, nextCursor: null });
    }

    @Get('privacy-requests/:id')
    @Route({ permission: 'patient', resolver: 'privacy-request' })
    async get(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const v = await run(req, (tx) => d.requests.getOwn(tx, id));
      send(res, 200, v, { ETag: etag(v.version) });
    }

    @Post('privacy-requests/:id/export/download-url')
    @Route({ permission: 'patient', resolver: 'privacy-request' })
    async downloadUrl(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const u = await run(req, (tx) => d.packages.downloadUrl(tx, metaOf(req), id));
      send(res, 200, u);
    }
  }

  @Controller('api/v1')
  class PrivacyStaffController {
    @Post('patients/:patientId/privacy-requests')
    @Route({ permission: 'privacy.request.create_for_patient', resolver: 'privacy-patient' })
    async createFor(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/privacy-requests',
        [patientId.toLowerCase()],
        async (tx) => {
          const v = await d.requests.createForPatient(tx, metaOf(req), patientId, bodyOf(req));
          return { status: 201, body: v };
        },
      );
    }
  }

  @Controller('api/v1')
  class PrivacyAdminController {
    @Get('admin/privacy-requests')
    @Route({ permission: 'privacy.request.manage', resolver: 'none' })
    async list(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const status = typeof req.query?.['status'] === 'string' ? req.query['status'] : undefined;
      const limit = limitOf(req);
      const cursor = cursorOf(req);
      const out = await run(req, (tx) =>
        d.requests.list(tx, {
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      send(res, 200, out);
    }

    @Post('admin/privacy-requests/:id/verify-identity')
    @Route({ permission: 'privacy.request.manage', resolver: 'none' })
    async verify(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const v = await run(
        req,
        (tx) => d.requests.verifyIdentity(tx, metaOf(req), id, bodyOf(req)),
        true,
      );
      send(res, 200, v, { ETag: etag(v.version) });
    }

    @Post('admin/privacy-requests/:id/decide')
    @Route({ permission: 'privacy.request.manage', resolver: 'none' })
    async decide(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const v = await run(req, (tx) => d.requests.decide(tx, metaOf(req), id, bodyOf(req)), true);
      send(res, 200, v, { ETag: etag(v.version) });
    }

    @Get('admin/incidents')
    @Route({ permission: 'privacy.incident.manage', resolver: 'none' })
    async incidents(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const limit = limitOf(req);
      const cursor = cursorOf(req);
      const out = await run(req, (tx) =>
        d.incidents.list(tx, {
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      send(res, 200, out);
    }

    @Post('admin/incidents')
    @Route({ permission: 'privacy.incident.manage', resolver: 'none' })
    async createIncident(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const v = await run(req, (tx) => d.incidents.create(tx, metaOf(req), bodyOf(req)));
      send(res, 201, v, { ETag: etag(v.version), Location: `/api/v1/admin/incidents` });
    }

    @Patch('admin/incidents')
    @Route({ permission: 'privacy.incident.manage', resolver: 'none' })
    async updateIncident(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const v = await run(req, (tx) => d.incidents.update(tx, metaOf(req), version, bodyOf(req)));
      send(res, 200, v, { ETag: etag(v.version) });
    }
  }

  return [PrivacyPatientController, PrivacyStaffController, PrivacyAdminController];
}
