// The route guard (ARCHITECTURE 27.1, BD-07): deny by default. A handler with no declaration is refused; a declared
// route is handed to the policy, which identity fills in later (session, realm, permission, elevation, resolver).
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from './errors.js';
import type { Req } from './http.js';
import { PUBLIC } from './permissions.js';
import { ROUTE_META } from './route.js';
import type { RouteDeclaration } from './route.js';

export const GUARD_POLICY = Symbol('GUARD_POLICY');

export interface GuardPolicy {
  /** Resolve the session and decide. Throw ApiError 401 `auth.unauthenticated` or 403 `auth.forbidden`. */
  authorize(req: Req, decl: RouteDeclaration): Promise<void>;
}

/** Until identity ships, nothing but `public` routes can pass: there is no session to evaluate. */
export class DenyUntilIdentityPolicy implements GuardPolicy {
  authorize(_req: Req, decl: RouteDeclaration): Promise<void> {
    if (decl.permission === PUBLIC) return Promise.resolve();
    return Promise.reject(new ApiError(401, 'auth.unauthenticated'));
  }
}

@Injectable()
export class RouteGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(GUARD_POLICY) private readonly policy: GuardPolicy,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const decl = this.reflector.get<RouteDeclaration | undefined>(ROUTE_META, ctx.getHandler());
    if (decl === undefined) throw new ApiError(403, 'auth.forbidden'); // undeclared: deny by default
    await this.policy.authorize(ctx.switchToHttp().getRequest<Req>(), decl);
    return true;
  }
}
