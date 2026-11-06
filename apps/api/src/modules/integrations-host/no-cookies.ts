// The `integrations.` host accepts no cookies (ARCHITECTURE 3.1, 5.3, ADR-005): token and signature authentication only. A `Cookie`
// header is dropped before a handler can see it, so a browser session sent to this host authenticates nothing and changes no answer,
// and no `Set-Cookie` can leave it, whatever a handler or library sets.
import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Req, Res } from '../../platform/http.js';

export function dropCookies(req: Req, res: Res): void {
  delete req.headers['cookie'];
  res.removeHeader('Set-Cookie');
  const set = res.setHeader.bind(res);
  res.setHeader = (name: string, value: string | number | readonly string[]): unknown =>
    /^set-cookie$/i.test(name) ? res : set(name, value);
}

/** Controller-level guard: it runs after the platform guard, before any handler. */
@Injectable()
export class NoCookiesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    dropCookies(http.getRequest<Req>(), http.getResponse<Res>());
    return true;
  }
}
