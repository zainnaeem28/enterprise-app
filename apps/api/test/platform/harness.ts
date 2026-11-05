// Test harness: a real Nest application on an ephemeral loopback port, driven with real HTTP requests.
import { Controller, Get, Patch, Post } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { createLogger } from '@ehr/kernel';
import { createApp } from '../../src/platform/app.js';
import type { AppDeps } from '../../src/platform/app.js';
import type { PlatformConfig } from '../../src/platform/config.js';
import { DenyUntilIdentityPolicy } from '../../src/platform/guard.js';
import type { GuardPolicy } from '../../src/platform/guard.js';
import { PUBLIC } from '../../src/platform/permissions.js';
import { Route } from '../../src/platform/route.js';
import type { RouteDeclaration } from '../../src/platform/route.js';
import type { Req } from '../../src/platform/http.js';

export const MIN_RELEASE = 141;
export const cfg = (over: Partial<PlatformConfig> = {}): PlatformConfig => ({
  minClientRelease: MIN_RELEASE,
  instanceCount: 1,
  integrationsHostPrefix: 'integrations.',
  port: 0,
  requestTimeoutMs: 15_000,
  ...over,
});

/** Counts everything that must NOT happen for a refused request. */
export const effects = { handler: 0, policy: 0, sessionWrites: 0, idempotencyRows: 0 };
export const resetEffects = (): void => {
  effects.handler = effects.policy = effects.sessionWrites = effects.idempotencyRows = 0;
};

const open: RouteDeclaration = { permission: PUBLIC, resolver: 'none' };

@Controller()
export class FixtureController {
  @Get('api/v1/ping')
  @Route(open)
  ping(): { ok: true } {
    effects.handler++;
    return { ok: true };
  }
  @Post('api/v1/echo')
  @Route(open)
  echo(): { ok: true } {
    effects.handler++;
    return { ok: true };
  }
  @Post('api/v1/echo-json')
  @Route(open)
  echoJson(): { ok: true } {
    return { ok: true };
  }
  @Patch('api/v1/notes/:id')
  @Route(open)
  note(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/protected')
  @Route({ permission: 'patient.read', resolver: 'patient' })
  protectedRoute(): { ok: true } {
    effects.handler++;
    return { ok: true };
  }
  @Get('api/v1/undeclared')
  undeclared(): { ok: true } {
    effects.handler++;
    return { ok: true };
  }
  @Get('api/v1/slow')
  @Route(open)
  async slow(): Promise<{ ok: true }> {
    await new Promise((r) => setTimeout(r, 600));
    return { ok: true };
  }
  @Get('api/v1/auth/sign-in')
  @Route({ ...open, releaseExempt: true })
  signIn(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/auth/callback')
  @Route({ ...open, releaseExempt: true })
  callback(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/calendar-link/callback')
  @Route({ ...open, releaseExempt: true })
  calCallback(): { ok: true } {
    return { ok: true };
  }
  @Get('api/v1/appointments/:id/calendar.ics')
  @Route({ ...open, releaseExempt: true })
  ics(): { ok: true } {
    return { ok: true };
  }
  @Get('public/v1/status')
  @Route(open)
  publicStatus(): { ok: true } {
    return { ok: true };
  }
}

export class CountingPolicy extends DenyUntilIdentityPolicy implements GuardPolicy {
  override authorize(req: Req, decl: RouteDeclaration): Promise<void> {
    effects.policy++;
    return super.authorize(req, decl);
  }
}

export interface Running {
  base: string;
  close(): Promise<void>;
  app: Awaited<ReturnType<typeof createApp>>;
}

export async function start(
  over: Partial<AppDeps> & { config?: PlatformConfig } = {},
): Promise<Running> {
  const lines: string[] = [];
  const app = await createApp({
    config: over.config ?? cfg(),
    logger: createLogger({ sink: (l) => lines.push(l) }),
    readiness: over.readiness ?? { missingRelations: () => Promise.resolve([]) },
    policy: over.policy ?? new CountingPolicy(),
    controllers: [FixtureController, ...((over.controllers ?? []) as Type<unknown>[])],
    ...(over.limiter ? { limiter: over.limiter } : {}),
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { base: url.replace('[::1]', '127.0.0.1'), close: () => app.close(), app };
}

export const R = (n: number): string => `r${n}.3f9a1c2b7d10`;
