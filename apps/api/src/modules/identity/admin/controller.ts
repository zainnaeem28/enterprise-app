// The admin routes of ARCHITECTURE 29.1 (WebAuthn sign-in, elevation, enrolment) and 29.4 (identity part; † = elevation).
// Authorization is the guard's (permission, realm `admin_pool`, elevation); the handlers repeat nothing of it except the
// Origin check on the anonymous writes (the guard runs CSRF and Origin only for requests that carry a session, 26.2).
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
import type { Req, Res } from '../../../platform/http.js';
import { PUBLIC } from '../../../platform/permissions.js';
import { Route } from '../../../platform/route.js';
import { ForbiddenError } from '../errors.js';
import { requireAuthContext } from '../guard-policy.js';
import type { SessionService } from '../sessions.js';
import { buildCookie, hashPresentedToken, parseCookies, SID_COOKIE } from '../tokens.js';
import type { SessionGrant, AdminCeremonies, Client } from './ceremony.js';
import type { AdminService, Meta } from './service.js';

export interface AdminControllerDeps {
  ceremonies: AdminCeremonies;
  service: AdminService;
  sessions: SessionService;
  /** Origins accepted on the anonymous writes (the `staff.` origin). */
  allowedOrigins: readonly string[];
  now?: () => number;
}

const clientOf = (req: Req): Client => ({
  ip: req.ip ?? 'unknown',
  userAgent: req.header('user-agent') ?? null,
});
const metaOf = (req: Req): Meta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

export function createAdminController(d: AdminControllerDeps): Type<unknown> {
  const now = d.now ?? Date.now;

  const assertOrigin = (req: Req): void => {
    const origin = req.header('origin');
    if (origin === undefined || !d.allowedOrigins.includes(origin))
      throw new ForbiddenError('auth.csrf_failed');
  };

  /** SAR-IDF-04: a live session the browser still holds is revoked first, in its own transaction; failures later fail closed. */
  async function revokeHeldSession(req: Req): Promise<void> {
    const old = hashPresentedToken(parseCookies(req.headers['cookie']).get(SID_COOKIE));
    if (old === undefined) return;
    const found = await d.sessions.lookup(old);
    if (found.state === 'live')
      await d.sessions.revoke(
        found.session,
        found.session.realm === 'admin_pool' ? 'sign_out' : 'realm_switch',
      );
  }

  const sessionCookie = (g: { token: { token: string }; absoluteExpiresAt: Date }): string =>
    buildCookie(SID_COOKIE, g.token.token, {
      maxAgeSeconds: Math.max(1, Math.floor((g.absoluteExpiresAt.getTime() - now()) / 1000)),
      sameSite: 'Strict',
    });

  const sessionBody = (g: SessionGrant): Record<string, unknown> => ({
    principalId: g.principalId,
    csrfToken: g.csrfToken,
    idleExpiresAt: g.idleExpiresAt.toISOString(),
  });

  @Controller('api/v1/admin')
  class AdminController {
    // --- anonymous ceremonies (29.1) -------------------------------------------------------------------------------------

    @Post('auth/sign-in/options')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'none' })
    async signInOptions(@ReqParam() req: Req): Promise<unknown> {
      assertOrigin(req);
      return d.ceremonies.signInOptions(
        (req.body as { handle?: unknown } | undefined)?.handle,
        clientOf(req),
      );
    }

    @Post('auth/sign-in/verify')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'none' })
    async signInVerify(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
    ): Promise<unknown> {
      assertOrigin(req);
      await revokeHeldSession(req);
      const g = await d.ceremonies.signInVerify(req.body, clientOf(req));
      res.setHeader('Set-Cookie', [sessionCookie(g)]);
      return sessionBody(g);
    }

    @Post('auth/enrolment/options')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'none' })
    async enrolmentOptions(@ReqParam() req: Req): Promise<unknown> {
      assertOrigin(req);
      return d.ceremonies.enrolmentOptions(req.body, clientOf(req));
    }

    @Post('auth/enrolment/verify')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'none' })
    async enrolmentVerify(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
    ): Promise<unknown> {
      assertOrigin(req);
      await revokeHeldSession(req);
      const g = await d.ceremonies.enrolmentVerify(req.body, clientOf(req));
      res.setHeader('Set-Cookie', [sessionCookie(g)]);
      return sessionBody(g);
    }

    // --- elevation (C1): an admin session, no permission of its own ----------------------------------------------------------

    @Post('auth/elevation/options')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'admin_pool' })
    async elevationOptions(@ReqParam() req: Req): Promise<unknown> {
      return d.ceremonies.elevationOptions(requireAuthContext(req));
    }

    @Post('auth/elevation/verify')
    @HttpCode(200)
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'admin_pool' })
    async elevationVerify(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
    ): Promise<unknown> {
      const ctx = requireAuthContext(req);
      const r = await d.ceremonies.elevationVerify(ctx, req.body, metaOf(req));
      res.setHeader('Set-Cookie', [
        sessionCookie({ token: r.token, absoluteExpiresAt: ctx.session.absoluteExpiresAt }),
      ]);
      return { elevationExpiresAt: r.elevationExpiresAt.toISOString() };
    }

    // --- principals and roles --------------------------------------------------------------------------------------------------

    @Get('principals')
    @Route({ permission: 'identity.principal.read', resolver: 'none', realm: 'admin_pool' })
    async listPrincipals(@ReqParam() req: Req): Promise<unknown> {
      const items = await d.service.listPrincipals(
        requireAuthContext(req),
        req.query['realm'],
        req.query['q'],
      );
      return { items, nextCursor: null };
    }

    @Post('principals')
    @HttpCode(200)
    @Route({
      permission: 'identity.role_change.request',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async createPrincipal(@ReqParam() req: Req): Promise<unknown> {
      return d.service.createPrincipal(requireAuthContext(req), req.body, metaOf(req));
    }

    @Get('roles')
    @Route({ permission: 'identity.principal.read', resolver: 'none', realm: 'admin_pool' })
    async listRoles(@ReqParam() req: Req): Promise<unknown> {
      return { items: await d.service.listRoles(requireAuthContext(req)), nextCursor: null };
    }

    @Post('principals/:id/kill-switch')
    @HttpCode(200)
    @Route({
      permission: 'identity.principal.kill',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async killSwitch(@ReqParam() req: Req, @Param('id') id: string): Promise<unknown> {
      return d.service.killSwitch(requireAuthContext(req), id, req.body, metaOf(req));
    }

    // --- role changes (C4) -------------------------------------------------------------------------------------------------------

    @Post('role-change-requests')
    @HttpCode(200)
    @Route({
      permission: 'identity.role_change.request',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async requestRoleChange(@ReqParam() req: Req): Promise<unknown> {
      return d.service.requestRoleChange(requireAuthContext(req), req.body, metaOf(req));
    }

    @Post('role-change-requests/:id/approve')
    @HttpCode(200)
    @Route({
      permission: 'identity.role_change.approve',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async approve(@ReqParam() req: Req, @Param('id') id: string): Promise<unknown> {
      return d.service.decideRoleChange(requireAuthContext(req), id, 'approve', metaOf(req));
    }

    @Post('role-change-requests/:id/reject')
    @HttpCode(200)
    @Route({
      permission: 'identity.role_change.approve',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async reject(@ReqParam() req: Req, @Param('id') id: string): Promise<unknown> {
      return d.service.decideRoleChange(requireAuthContext(req), id, 'reject', metaOf(req));
    }

    @Post('role-change-requests/:id/cancel')
    @HttpCode(200)
    @Route({ permission: 'identity.role_change.approve', resolver: 'none', realm: 'admin_pool' })
    async cancel(@ReqParam() req: Req, @Param('id') id: string): Promise<unknown> {
      return d.service.decideRoleChange(requireAuthContext(req), id, 'cancel', metaOf(req));
    }

    // --- enrolment tokens (26.3) ---------------------------------------------------------------------------------------------------

    @Post('enrolment-tokens')
    @HttpCode(200)
    @Route({
      permission: 'identity.enrolment.request',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async requestToken(@ReqParam() req: Req): Promise<unknown> {
      const r = await d.service.requestEnrolmentToken(
        requireAuthContext(req),
        req.body,
        metaOf(req),
      );
      return { id: r.id, expiresAt: r.expiresAt.toISOString() };
    }

    @Post('enrolment-tokens/:id/approve')
    @HttpCode(200)
    @Route({
      permission: 'identity.enrolment.approve',
      resolver: 'none',
      realm: 'admin_pool',
      elevation: true,
    })
    async approveToken(@ReqParam() req: Req, @Param('id') id: string): Promise<unknown> {
      const r = await d.service.approveEnrolmentToken(requireAuthContext(req), id, metaOf(req));
      return { token: r.token, expiresAt: r.expiresAt.toISOString() };
    }
  }
  return AdminController;
}
