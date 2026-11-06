// The messaging routes of ARCHITECTURE 29.2 and 29.3. Each declares {permission, resolver} (BD-07); the guard has already authenticated,
// checked CSRF, the realm and the resolver's result by the time a handler runs, and the handler opens the one transaction under the
// caller's scope, so row-level security is the second line and the triggers the third.
//
//   GET/POST /threads                        messaging.thread.staff   Idem; participant only (a thread is seen by its participants)
//   GET/POST /threads/{id}/messages          messaging.thread.staff   Idem; participant only
//   GET/POST /tasks                          messaging.task.manage    Idem; assignee or creator
//   PATCH    /tasks/{id}                     messaging.task.manage    If-Match; assignee completes, creator cancels or edits
//   GET/POST /patients/{patientId}/threads   patient                  Idem; ONLY while the organisation flag `patient_messaging` is on (D-5); else 404
//
// Known limit (README O-2): 29.2 also lists `POST /threads/{id}/messages` for the patient host. One handler cannot carry two
// permissions in the route inventory, so a patient's reply on an existing thread is not served until the platform allows it;
// a patient's thread starts with their first message and the patient route returns each thread with its messages.
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
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import type { ResourceResolver } from '../identity/index.js';
import { ifMatchVersion } from '../patient/index.js';
import { MessagingValidationError } from './errors.js';
import { isUuid } from './ids.js';
import type { TaskService } from './tasks.js';
import type { ThreadService } from './threads.js';
import type { CallerRoles, RequestMeta } from './types.js';

export interface MessagingControllerDeps {
  db: KernelDb;
  threads: ThreadService;
  tasks: TaskService;
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

const bodyOf = (req: Req): Record<string, unknown> => {
  const b = req.body;
  if (b === undefined || b === null || typeof b !== 'object' || Array.isArray(b))
    throw new MessagingValidationError(['body']);
  return b as Record<string, unknown>;
};

const limitOf = (req: Req): number | undefined => {
  const q = req.query?.['limit'];
  if (q === undefined) return undefined;
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new MessagingValidationError(['limit']);
  return n;
};
const cursorOf = (req: Req): string | undefined => {
  const q = req.query?.['cursor'];
  if (q === undefined) return undefined;
  if (typeof q !== 'string' || q.length > 200) throw new MessagingValidationError(['cursor']);
  return q;
};
const paging = (req: Req): { limit?: number; cursor?: string } => {
  const limit = limitOf(req);
  const cursor = cursorOf(req);
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
};

const rolesOf = (req: Req): CallerRoles => ({
  roles: requireAuthContext(req).roles.map((r) => ({
    key: r.key,
    ...(r.locationId === undefined ? {} : { locationId: r.locationId }),
  })),
});

/** Resolvers (27.1): the patient of a `/patients/{patientId}/...` path; the guard checks the patient is the caller's own (patient realm). */
export function messagingResolvers(): Record<string, ResourceResolver> {
  return {
    'messaging-patient': (req) => {
      const m = /\/patients\/([0-9a-f-]{36})(?:\/|$)/i.exec(req.path);
      return Promise.resolve(
        m?.[1] !== undefined && isUuid(m[1]) ? { patientId: m[1].toLowerCase() } : undefined,
      );
    },
  };
}

export function createMessagingControllers(d: MessagingControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

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
  class MessagingThreadController {
    @Get('threads')
    @Route({ permission: 'messaging.thread.staff', resolver: 'none' })
    async list(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      send(res, 200, await run(req, (tx) => d.threads.listStaff(tx, paging(req))));
    }

    @Post('threads')
    @Route({ permission: 'messaging.thread.staff', resolver: 'none' })
    async create(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /threads', [], async (tx) => {
        const v = await d.threads.createStaff(tx, metaOf(req), bodyOf(req));
        return { status: 201, body: v, location: `/api/v1/threads/${v.id}/messages` };
      });
    }

    @Get('threads/:id/messages')
    @Route({ permission: 'messaging.thread.staff', resolver: 'none' })
    async messages(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, await run(req, (tx) => d.threads.messages(tx, metaOf(req), id, paging(req))));
    }

    @Post('threads/:id/messages')
    @Route({ permission: 'messaging.thread.staff', resolver: 'none' })
    async post(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /threads/{id}/messages', [id.toLowerCase()], async (tx) => {
        const v = await d.threads.post(tx, metaOf(req), id, bodyOf(req));
        return { status: 201, body: v };
      });
    }
  }

  @Controller('api/v1')
  class MessagingTaskController {
    @Get('tasks')
    @Route({ permission: 'messaging.task.manage', resolver: 'none' })
    async list(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const status = typeof req.query?.['status'] === 'string' ? req.query['status'] : undefined;
      const out = await run(req, (tx) =>
        d.tasks.list(tx, rolesOf(req), {
          ...paging(req),
          ...(status === undefined ? {} : { status }),
        }),
      );
      send(res, 200, out);
    }

    @Post('tasks')
    @Route({ permission: 'messaging.task.manage', resolver: 'none' })
    async create(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /tasks', [], async (tx) => {
        const v = await d.tasks.create(tx, metaOf(req), bodyOf(req));
        return { status: 201, body: v, location: `/api/v1/tasks/${v.id}` };
      });
    }

    @Patch('tasks/:id')
    @Route({ permission: 'messaging.task.manage', resolver: 'none' })
    async patch(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const v = await run(req, (tx) =>
        d.tasks.patch(tx, metaOf(req), rolesOf(req), id, version, bodyOf(req)),
      );
      send(res, 200, v, { ETag: etag(v.version) });
    }
  }

  @Controller('api/v1')
  class MessagingPatientController {
    @Get('patients/:patientId/threads')
    @Route({ permission: 'patient', resolver: 'messaging-patient' })
    async list(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, await run(req, (tx) => d.threads.listForPatient(tx, patientId, paging(req))));
    }

    @Post('patients/:patientId/threads')
    @Route({ permission: 'patient', resolver: 'messaging-patient' })
    async create(
      @Param('patientId') patientId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/threads',
        [patientId.toLowerCase()],
        async (tx) => {
          const v = await d.threads.createForPatient(tx, metaOf(req), patientId, bodyOf(req));
          return { status: 201, body: v };
        },
      );
    }
  }

  return [MessagingThreadController, MessagingTaskController, MessagingPatientController];
}
