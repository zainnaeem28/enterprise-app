// Telemetry configuration from the environment. Names of bad variables are reported, never values.
// Defaults match infra/modules/observability output app_otel_environment (ADOT sidecar on the task's loopback).

export interface TelemetryConfig {
  readonly enabled: boolean;
  /** Always a loopback OTLP/HTTP endpoint: the application never sends telemetry out of the task itself. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly releaseNumber: number | undefined;
}

export class TelemetryConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`telemetry configuration invalid: ${problems.join('; ')}`);
  }
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]{2,5}\/?$/;

export function loadTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
): TelemetryConfig {
  const problems: string[] = [];
  const mode = env['EHR_TELEMETRY'] ?? 'off';
  if (mode !== 'on' && mode !== 'off') problems.push('EHR_TELEMETRY must be on or off');
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://127.0.0.1:4318';
  if (!LOOPBACK.test(endpoint))
    problems.push('OTEL_EXPORTER_OTLP_ENDPOINT must be a loopback http endpoint with a port');
  const protocol = env['OTEL_EXPORTER_OTLP_PROTOCOL'] ?? 'http/protobuf';
  if (protocol !== 'http/protobuf' && protocol !== 'http/json')
    problems.push('OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf or http/json');
  const rn = env['EHR_RELEASE_NUMBER'];
  if (rn !== undefined && !/^[1-9][0-9]{0,9}$/.test(rn))
    problems.push('EHR_RELEASE_NUMBER must be a positive integer');
  const serviceName = env['OTEL_SERVICE_NAME'] ?? 'ehr-api';
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(serviceName))
    problems.push('OTEL_SERVICE_NAME must be a lower-case slug');
  const environment = env['EHR_ENVIRONMENT'] ?? 'unknown';
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(environment))
    problems.push('EHR_ENVIRONMENT must be a lower-case slug');
  if (problems.length > 0) throw new TelemetryConfigError(problems);
  return {
    enabled: mode === 'on',
    endpoint,
    serviceName,
    serviceVersion: env['EHR_SERVICE_VERSION'] ?? '0.0.0',
    environment,
    releaseNumber: rn === undefined ? undefined : Number(rn),
  };
}

/** Resource attributes; every key is on the allowlist. */
export function resourceAttributes(cfg: TelemetryConfig): Record<string, string | number> {
  const a: Record<string, string | number> = {
    'service.name': cfg.serviceName,
    'service.version': cfg.serviceVersion,
    'deployment.environment.name': cfg.environment,
    'cloud.provider': 'aws',
  };
  if (cfg.releaseNumber !== undefined) a['ehr.release_number'] = cfg.releaseNumber;
  return a;
}
