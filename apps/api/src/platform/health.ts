// Liveness and readiness (DEVOPS-PLAN 5, DPR-04). `/healthz` is shallow: no database, no external call.
// `/readyz` is deep: the database answers and every relation this build declares as its minimum schema exists.
// (The migration tracker is closed to application roles by F-03, so a numeric version cannot be read; the declared
// relation set is the compatibility check available to `app_api`. Later schemas pass: expand-only rule, DPR-04.)
// Neither response carries PHI, and neither needs the client-release header.
import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import { ApiError } from './errors.js';
import { PUBLIC } from './permissions.js';
import { Route } from './route.js';

export const READINESS = Symbol('READINESS');

export interface ReadinessProbe {
  /** Declared relations that do not exist; rejects when the database is unreachable. */
  missingRelations(): Promise<string[]>;
}

@Injectable()
export class Lifecycle {
  draining = false;
}

@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS) private readonly probe: ReadinessProbe,
    @Inject(Lifecycle) private readonly lifecycle: Lifecycle,
  ) {}

  @Get('healthz')
  @Route({ permission: PUBLIC, resolver: 'none', releaseExempt: true, routeClass: 'health' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Route({ permission: PUBLIC, resolver: 'none', releaseExempt: true, routeClass: 'health' })
  async ready(): Promise<{ status: 'ready' }> {
    if (this.lifecycle.draining) throw new ApiError(503, 'kernel.unavailable', true);
    let missing: string[];
    try {
      missing = await this.probe.missingRelations();
    } catch {
      throw new ApiError(503, 'kernel.unavailable', true);
    }
    if (missing.length > 0) throw new ApiError(503, 'kernel.unavailable', true);
    return { status: 'ready' };
  }
}
