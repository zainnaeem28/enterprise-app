// Platform-layer configuration from the environment. Names of bad variables are reported, never values.
import { ConfigError } from '@ehr/kernel';

export interface PlatformConfig {
  /** Integer in the release configuration (28.6; DEVOPS-PLAN 6.2). */
  readonly minClientRelease: number;
  /** Instances behind the load balancer; the in-memory rate limit is divided by it (31.3). */
  readonly instanceCount: number;
  /** Host name prefix of the machine-client host (exempt from the release check and from cookies). */
  readonly integrationsHostPrefix: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
}

export function loadPlatformConfig(
  env: Readonly<Record<string, string | undefined>>,
): PlatformConfig {
  const problems: string[] = [];
  const int = (name: string, dflt: number | undefined, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) {
      if (dflt === undefined) problems.push(`${name} is required`);
      return dflt ?? min;
    }
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max)
      problems.push(`${name} must be an integer ${min}..${max}`);
    return n;
  };
  const cfg: PlatformConfig = {
    minClientRelease: int('EHR_MIN_CLIENT_RELEASE', undefined, 1, 2_000_000_000),
    instanceCount: int('EHR_INSTANCE_COUNT', 1, 1, 100),
    integrationsHostPrefix: env['EHR_INTEGRATIONS_HOST_PREFIX'] ?? 'integrations.',
    port: int('EHR_PORT', 3000, 1, 65535),
    requestTimeoutMs: int('EHR_REQUEST_TIMEOUT_MS', 15_000, 100, 120_000),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
