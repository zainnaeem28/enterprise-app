// The documents routes of ARCHITECTURE 29.2 and 29.3. Each declares {permission, resolver} (BD-07); the guard has already
// authenticated, checked CSRF, the realm and the resolver's result by the time a handler runs, and the handler opens the one
// transaction under the caller's scope, so row-level security is the second line. A document the caller cannot see is 404 (CN-04,
// TC-DOC-06). No handler reads, returns or logs a file name; nothing here sees file content (the browser talks to the object store).
//
// Mounted: the patient-portal routes (29.2) at the paths they share with staff, and every staff-only route (29.3). The staff variants
// of the five shared paths (`POST /patients/{id}/document-uploads`, `POST /document-uploads/{id}/complete`,
// `GET /patients/{id}/documents`, `POST /documents/{id}/download-url`) are not mounted: the guard derives a route's realm from its
// permission and the framework has one handler per path, so the same path cannot carry both declarations (README, open item O-1,
// the same question BE-11 raised). The service is realm-neutral and is tested for staff.
import {
  Controller,
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
import { ApiError, problemBody } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import type { ResourceResolver } from '../identity/index.js';
import { ifMatchVersion } from '../patient/index.js';
import { DocumentsValidationError, LegalHoldError, RetentionError } from './errors.js';
import { isUuid } from './ids.js';
import type { DocumentsService } from './service.js';
import type {
  Classification,
  DeletionRequestView,
  DocumentView,
  HoldAction,
  RequestMeta,
} from './types.js';

export interface DocumentsControllerDeps {
  db: KernelDb;
  documents: DocumentsService;
}

const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (res: Res, status: number, body: unknown): void => {
  res.setHeader('Cache-Control', 'no-store');
  if (status >= 400) res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.status(status).json(body);
};

const etag = (version: number): string => `W/"${version}"`;

/** The document as the API returns it: no object key, no bucket, no hash. */
const docBody = (d: DocumentView, staff: boolean): Record<string, unknown> => ({
  id: d.id,
  patientId: d.patientId,
  classification: d.classification,
  status: d.status,
  uploadChannel: d.uploadChannel,
  uploadedAt: d.uploadedAt,
  confirmedAt: d.confirmedAt,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  ...(staff
    ? {
        suggestedClassification: d.suggestedClassification,
        retentionUntil: d.retentionUntil,
        onLegalHold: d.onLegalHold ?? false,
      }
    : {}),
});

const UUID_IN_PATH = (path: string, segment: string): string | undefined => {
  const m = new RegExp(`/${segment}/([0-9a-f-]{36})(?:/|$)`, 'i').exec(path);
  return m?.[1] !== undefined && isUuid(m[1]) ? m[1].toLowerCase() : undefined;
};

/** Resolvers (27.1): each returns the resource's patient when the caller's own RLS shows it, `undefined` otherwise (404). */
export function documentsResolvers(): Record<string, ResourceResolver> {
  return {
    // /patients/{patientId}/...
    'documents-patient': (req) => {
      const id = UUID_IN_PATH(req.path, 'patients');
      return Promise.resolve(id === undefined ? undefined : { patientId: id });
    },
    // /documents/{id}/... and /document-uploads/{id}/complete
    document: async (req, _ctx, tx) => {
      const id = UUID_IN_PATH(req.path, 'documents') ?? UUID_IN_PATH(req.path, 'document-uploads');
      if (id === undefined) return undefined;
      const r = await tx.query(`SELECT patient_id FROM documents.document WHERE id = $1::uuid`, [
        id,
      ]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? undefined : { patientId: String(row['patient_id']) };
    },
    // /deletion-requests/{id}/decide
    'deletion-request': async (req, _ctx, tx) => {
      const id = UUID_IN_PATH(req.path, 'deletion-requests');
      if (id === undefined) return undefined;
      const r = await tx.query(
        `SELECT patient_id FROM documents.deletion_request WHERE id = $1::uuid`,
        [id],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? undefined : { patientId: String(row['patient_id']) };
    },
  };
}

export function createDocumentsControllers(d: DocumentsControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);
  const staffOf = (req: Req): boolean => requireAuthContext(req).scope.audience === 'staff';

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

  /** A recorded refusal: the row is committed with the transaction, and the answer is the registry's 409 for it. */
  const refusal = (req: Req, v: DeletionRequestView): { status: number; body: unknown } => {
    const err =
      v.outcome === 'refused_legal_hold' ? new LegalHoldError(v.id) : new RetentionError(v.id);
    return { status: err.status, body: problemBody(err, req.requestId ?? 'unknown') };
  };

  @Controller('api/v1')
  class DocumentsPatientController {
    @Post('patients/:patientId/document-uploads')
    @Route({ permission: 'patient', resolver: 'documents-patient' })
    async createUpload(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/document-uploads',
        [patientId.toLowerCase()],
        req.body,
        async (tx) => {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const t = await d.documents.createUpload(tx, metaOf(req), {
            patientId,
            contentType: b['contentType'] as string,
            sizeBytes: b['sizeBytes'] as number,
            ...(typeof b['fileName'] === 'string' ? { fileName: b['fileName'] } : {}),
            ...(typeof b['classification'] === 'string'
              ? { classification: b['classification'] as Classification }
              : {}),
          });
          return { status: 201, body: t, location: `/api/v1/documents/${t.documentId}` };
        },
      );
    }

    @Post('document-uploads/:documentId/complete')
    @Route({ permission: 'patient', resolver: 'document' })
    async complete(
      @Param('documentId') documentId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /document-uploads/{documentId}/complete',
        [documentId.toLowerCase()],
        req.body,
        async (tx) => ({
          status: 202,
          body: await d.documents.completeUpload(tx, metaOf(req), documentId),
        }),
      );
    }

    @Get('patients/:patientId/documents')
    @Route({ permission: 'patient', resolver: 'documents-patient' })
    async list(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const staff = staffOf(req);
      const items = await run(req, (tx) => d.documents.list(tx, patientId));
      send(res, 200, { items: items.map((x) => docBody(x, staff)), nextCursor: null });
    }

    @Post('documents/:documentId/download-url')
    @Route({ permission: 'patient', resolver: 'document' })
    async downloadUrl(
      @Param('documentId') documentId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const u = await run(req, (tx) => d.documents.downloadUrl(tx, metaOf(req), documentId));
      send(res, 200, u);
    }
  }

  @Controller('api/v1')
  class DocumentsStaffController {
    @Put('documents/:id/classification')
    @Route({ permission: 'documents.classify', resolver: 'document' })
    async classify(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b['classification'] !== 'string')
        throw new DocumentsValidationError(['classification']);
      const v = await run(req, (tx) =>
        d.documents.classify(tx, metaOf(req), id, {
          classification: b['classification'] as Classification,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        }),
      );
      res.setHeader('ETag', etag(v.version));
      send(res, 200, docBody(v, true));
    }

    @Post('documents/:id/confirm')
    @Route({ permission: 'documents.classify', resolver: 'document' })
    async confirm(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const expectedVersion = ifMatchVersion(req);
      const v = await run(req, (tx) =>
        d.documents.confirm(
          tx,
          metaOf(req),
          id,
          expectedVersion === undefined ? {} : { expectedVersion },
        ),
      );
      res.setHeader('ETag', etag(v.version));
      send(res, 200, docBody(v, true));
    }

    @Post('documents/:id/legal-holds')
    @Route({ permission: 'documents.legal_hold.manage', resolver: 'document' })
    async legalHold(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /documents/{id}/legal-holds',
        [id.toLowerCase()],
        req.body,
        async (tx) => {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const h = await d.documents.setLegalHold(tx, metaOf(req), id, {
            action: b['action'] as HoldAction,
            reason: b['reason'] as string,
          });
          return { status: 201, body: h };
        },
      );
    }

    @Post('documents/:id/deletion-requests')
    @Route({ permission: 'documents.upload', resolver: 'document' })
    async requestDeletion(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /documents/{id}/deletion-requests',
        [id.toLowerCase()],
        req.body,
        async (tx) => {
          const v = await d.documents.requestDeletion(tx, metaOf(req), id);
          if (v.outcome === 'refused_legal_hold' || v.outcome === 'refused_retention')
            return refusal(req, v);
          return { status: 201, body: v, location: `/api/v1/deletion-requests/${v.id}` };
        },
      );
    }

    @Post('deletion-requests/:id/decide')
    @Route({ permission: 'documents.deletion.decide', resolver: 'deletion-request' })
    async decide(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /deletion-requests/{id}/decide',
        [id.toLowerCase()],
        req.body,
        async (tx) => {
          const v = await d.documents.decideDeletion(tx, metaOf(req), id);
          if (v.outcome === 'refused_legal_hold' || v.outcome === 'refused_retention')
            return refusal(req, v);
          return { status: 200, body: v };
        },
      );
    }
  }

  return [DocumentsPatientController, DocumentsStaffController];
}
