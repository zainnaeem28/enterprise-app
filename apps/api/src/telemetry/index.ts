// OpenTelemetry wiring entry point. The SDK itself is injected (createSdk) because adding @opentelemetry/* packages
// to apps/api/package.json is outside this ticket's allowed paths (request to the Orchestrator, see the DO-07 evidence).
import { loadTelemetryConfig, resourceAttributes } from './config.js';
import type { TelemetryConfig } from './config.js';
import { wrapSpanExporter } from './exporter.js';
import type { SpanExporterLike, SpanLike } from './exporter.js';

export * from './allowlist.js';
export * from './config.js';
export * from './exporter.js';
export * from './scrub.js';

export interface SdkLike {
  start(): void;
  shutdown(): Promise<void>;
}

export interface SdkOptions {
  readonly config: TelemetryConfig;
  readonly resource: Record<string, string | number>;
  /** Pass the OTLP trace exporter through this before handing it to the SDK's span processor. */
  readonly wrapExporter: <S extends SpanLike>(exporter: SpanExporterLike<S>) => SpanExporterLike<S>;
}

export interface Telemetry {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

/** Starts telemetry when EHR_TELEMETRY=on. Returns a no-op handle otherwise. Must run before the app module is imported. */
export function startTelemetry(
  env: Readonly<Record<string, string | undefined>>,
  createSdk: (options: SdkOptions) => SdkLike,
): Telemetry {
  const config = loadTelemetryConfig(env);
  if (!config.enabled) return { enabled: false, shutdown: () => Promise.resolve() };
  const sdk = createSdk({
    config,
    resource: resourceAttributes(config),
    wrapExporter: wrapSpanExporter,
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
