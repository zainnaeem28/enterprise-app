// Application shell: module wiring and the middleware order of the platform layer.
//   request id / no-store / no CORS -> request timeout -> client-release check -> rate limit -> body limit -> JSON
//   parser -> (Nest) guard -> handler -> exception filter.
// The release check runs before anything that reads a table or writes a session field (28.6).
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from '@ehr/kernel';
import { clientReleaseMiddleware } from './client-release.js';
import type { ReleaseMetrics } from './client-release.js';
import type { PlatformConfig } from './config.js';
import { errorMiddleware, LOGGER, ProblemFilter } from './filter.js';
import { DenyUntilIdentityPolicy, GUARD_POLICY, RouteGuard } from './guard.js';
import type { GuardPolicy } from './guard.js';
import { baselineHeaders } from './headers.js';
import { HealthController, Lifecycle, READINESS } from './health.js';
import type { ReadinessProbe } from './health.js';
import type { Next, Req, Res } from './http.js';
import {
  bodyLimitMiddleware,
  JSON_BODY_LIMIT,
  REQUEST_TIMEOUT_MS,
  timeoutMiddleware,
  verifyBodySize,
} from './limits.js';
import { MemoryRateLimiter, rateLimitMiddleware } from './rate-limit.js';
import type { RateLimiter } from './rate-limit.js';
import { AlertStreamController, StreamRegistry } from './stream.js';

export const PLATFORM_CONTROLLERS: readonly Type<unknown>[] = [
  HealthController,
  AlertStreamController,
];

export interface AppDeps {
  config: PlatformConfig;
  logger: Logger;
  readiness: ReadinessProbe;
  /** Identity supplies the real policy later; the default refuses everything that is not `public`. */
  policy?: GuardPolicy;
  limiter?: RateLimiter;
  metrics?: ReleaseMetrics;
  /** Module controllers beyond the platform ones (feature modules, test fixtures). */
  controllers?: readonly Type<unknown>[];
  /** The notifications module's controller owns `GET /alerts/stream` (ALR-N3): leave out the platform's transport-only one. */
  replaceAlertStream?: boolean;
}

export function buildModule(deps: AppDeps): DynamicModule {
  @Module({})
  class PlatformModule {}
  return {
    module: PlatformModule,
    controllers: [
      ...PLATFORM_CONTROLLERS.filter(
        (c) => !(deps.replaceAlertStream && c === AlertStreamController),
      ),
      ...(deps.controllers ?? []),
    ],
    providers: [
      Lifecycle,
      StreamRegistry,
      { provide: READINESS, useValue: deps.readiness },
      { provide: GUARD_POLICY, useValue: deps.policy ?? new DenyUntilIdentityPolicy() },
      { provide: LOGGER, useValue: deps.logger },
      { provide: APP_GUARD, useClass: RouteGuard },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  };
}

const apiOnly =
  (mw: (req: Req, res: Res, next: Next) => void) =>
  (req: Req, res: Res, next: Next): void =>
    req.path.toLowerCase().startsWith('/api/') ? mw(req, res, next) : next();

export async function createApp(deps: AppDeps): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildModule(deps), {
    bodyParser: false,
    logger: false,
  });
  const metrics: ReleaseMetrics = deps.metrics ?? {
    refused: (r) =>
      deps.logger.warn('client_release_refused', {
        event: 'client_release_refused',
        ...(typeof r === 'number' ? { releaseNumber: r } : { code: r }),
      }),
  };
  const limiter = deps.limiter ?? new MemoryRateLimiter(deps.config.instanceCount);
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(baselineHeaders);
  app.use(timeoutMiddleware(deps.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS));
  app.use(clientReleaseMiddleware(deps.config, metrics));
  app.use(apiOnly(rateLimitMiddleware(limiter)));
  app.use(bodyLimitMiddleware);
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    type: 'application/json',
    verify: verifyBodySize,
  });
  app.use(errorMiddleware(deps.logger));
  app.enableShutdownHooks();
  return app;
}
