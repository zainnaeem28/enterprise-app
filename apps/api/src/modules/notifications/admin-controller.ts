// Message-template admin routes of ARCHITECTURE 29.4 (`staff.`, realm `admin_pool`; TC-AD-04, RA-R1-05, RA-R1-15):
//   GET  /api/v1/admin/message-templates                     list (filters `key`, `status`; `limit`, `cursor`)
//   POST /api/v1/admin/message-templates                     one row (key, channel, language) of a DRAFT version; `version` joins an existing draft
//   POST /api/v1/admin/message-templates/{id}/render-check   renders every row of the version, every channel and language
//   POST /api/v1/admin/message-templates/{id}/publish        publishes the version once its check passed (re-checked)
// The guard has already authenticated the session, checked `notifications.template.manage` and the live elevation grant before a
// handler runs. The variable allowlist is enforced by the service (and the database); the body here is parsed strictly, so an
// unknown field (a free-text binding) is a 400 and a variable outside the allowlist is a 422 `notifications.render_check_failed`
// that names rules only, never the offending text. Every accepted change is audited by the service in the same transaction.
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, ScopeSettings } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { NotificationsError, RenderCheckFailedError } from './errors.js';
import type { NewTemplate, TemplateService } from './templates.js';

export interface TemplateAdminDeps {
  db: KernelDb;
  templates: TemplateService;
  scopeOf: (req: Req) => ScopeSettings;
}

const PERMISSION = 'notifications.template.manage';
const route = () =>
  Route({ permission: PERMISSION, resolver: 'none', realm: 'admin_pool', elevation: true });
const BODY_KEYS = new Set([
  'key',
  'channel',
  'language',
  'version',
  'subject',
  'body',
  'variables',
]);
const VARIABLE_KEYS = new Set(['name', 'type']);
const STATUSES = new Set(['draft', 'published', 'retired']);

const invalid = (...paths: string[]): ApiError =>
  new ApiError(400, 'kernel.validation_failed', false, {
    errors: paths.map((p) => ({ path: `/${p}`, code: 'kernel.invalid_value' })),
  });

/** A module error leaves as its registry code; a 422 lists the failing rules (path = channel/language, code = rule). */
function toApi(e: unknown): unknown {
  if (e instanceof RenderCheckFailedError)
    return new ApiError(422, e.code, false, {
      errors: e.failures.map((f) => ({
        path: `/${[f.channel, f.language].filter(Boolean).join('/')}`,
        code: f.rule,
      })),
    });
  if (e instanceof NotificationsError) {
    const fields = (e as { fields?: readonly string[] }).fields;
    return new ApiError(
      e.status,
      e.code,
      e.retryable,
      fields === undefined
        ? {}
        : { errors: fields.map((f) => ({ path: `/${f}`, code: 'kernel.invalid_value' })) },
    );
  }
  return e;
}

/** Strict body: only the known fields; `variables` is a list of {name, type}. Content rules are the service's. */
function parseBody(b: unknown): NewTemplate {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw invalid('body');
  const o = b as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !BODY_KEYS.has(k));
  if (extra.length > 0) throw invalid(...extra.map(() => 'body'));
  const vars = o['variables'];
  if (!Array.isArray(vars) || vars.length > 50) throw invalid('variables');
  for (const v of vars)
    if (typeof v !== 'object' || v === null || Object.keys(v).some((k) => !VARIABLE_KEYS.has(k)))
      throw invalid('variables');
  return o as unknown as NewTemplate;
}

export function createTemplateAdminController(d: TemplateAdminDeps): Type<unknown> {
  const ctx = (req: Req) => ({ requestId: req.requestId ?? '' });
  const noStore = (res: Res): void => {
    res.setHeader('Cache-Control', 'no-store');
  };

  @Controller('api/v1/admin/message-templates')
  class TemplateAdminController {
    @Get()
    @route()
    async list(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      const q = req.query;
      const key = q['key'];
      const status = q['status'];
      if (key !== undefined && typeof key !== 'string') throw invalid('key');
      if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status)))
        throw invalid('status');
      const lim = q['limit'];
      let limit = 25;
      if (lim !== undefined) {
        const n = typeof lim === 'string' && /^\d{1,3}$/.test(lim) ? Number(lim) : NaN;
        if (!(n >= 1 && n <= 100)) throw invalid('limit');
        limit = n;
      }
      const cur = q['cursor'];
      let offset = 0;
      if (cur !== undefined && cur !== '') {
        const m =
          typeof cur === 'string' && cur.length <= 40
            ? /^o(\d{1,9})$/.exec(Buffer.from(cur, 'base64url').toString('utf8'))
            : null;
        if (m === null) throw invalid('cursor');
        offset = Number(m[1]);
      }
      try {
        const rows = await d.db.withScope(
          d.scopeOf(req),
          (tx) =>
            d.templates.list(tx, {
              ...(key === undefined ? {} : { key }),
              ...(status === undefined ? {} : { status }),
            }),
          { idempotent: true },
        );
        const more = rows.length > offset + limit;
        return {
          items: rows.slice(offset, offset + limit),
          nextCursor: more ? Buffer.from(`o${offset + limit}`, 'utf8').toString('base64url') : null,
        };
      } catch (e) {
        throw toApi(e);
      }
    }

    @Post()
    @HttpCode(200)
    @route()
    async create(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      noStore(res);
      const input = parseBody(req.body);
      try {
        return await d.db.withScope(d.scopeOf(req), (tx) =>
          d.templates.createDraft(tx, input, ctx(req)),
        );
      } catch (e) {
        throw toApi(e);
      }
    }

    @Post(':id/render-check')
    @HttpCode(200)
    @route()
    async renderCheck(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
    ) {
      noStore(res);
      try {
        return await d.db.withScope(d.scopeOf(req), (tx) =>
          d.templates.renderCheck(tx, id, ctx(req)),
        );
      } catch (e) {
        throw toApi(e);
      }
    }

    @Post(':id/publish')
    @HttpCode(200)
    @route()
    async publish(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
    ) {
      noStore(res);
      try {
        return await d.db.withScope(d.scopeOf(req), (tx) => d.templates.publish(tx, id, ctx(req)));
      } catch (e) {
        throw toApi(e);
      }
    }
  }
  return TemplateAdminController;
}
