// Wraps a span exporter so every span is scrubbed before it leaves the process. Structural types: the OpenTelemetry
// SDK is wired by the caller, so this file imports nothing from it and is testable without the SDK.
import { scrubAttributes, scrubSpanName } from './scrub.js';
import type { Attributes } from './scrub.js';

interface WithAttributes {
  readonly attributes?: Attributes;
}
export interface SpanLike {
  readonly name: string;
  readonly attributes: Attributes;
  readonly events?: ReadonlyArray<WithAttributes & { readonly name: string }>;
  readonly links?: ReadonlyArray<WithAttributes>;
  readonly resource?: { readonly attributes: Attributes };
  readonly status?: { readonly code: number; readonly message?: string };
}
export interface ExportResultLike {
  readonly code: number;
}
export interface SpanExporterLike<S extends SpanLike = SpanLike> {
  export(spans: S[], resultCallback: (result: ExportResultLike) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/** Copy of a span with scrubbed attributes. The prototype is kept, so SDK getters and methods still work. */
export function scrubSpan<S extends SpanLike>(span: S): S {
  const props: PropertyDescriptorMap = {
    name: { value: scrubSpanName(span.name), enumerable: true },
    attributes: { value: scrubAttributes(span.attributes).attributes, enumerable: true },
  };
  if (span.events)
    props['events'] = {
      value: span.events.map((e) => ({
        ...e,
        name: scrubSpanName(e.name),
        attributes: scrubAttributes(e.attributes).attributes,
      })),
      enumerable: true,
    };
  if (span.links)
    props['links'] = {
      value: span.links.map((l) => ({
        ...l,
        attributes: scrubAttributes(l.attributes).attributes,
      })),
      enumerable: true,
    };
  if (span.resource)
    props['resource'] = {
      value: { ...span.resource, attributes: scrubAttributes(span.resource.attributes).attributes },
      enumerable: true,
    };
  // Exception messages and stacks are free text from application code: never exported. Only status code and exception.type remain.
  if (span.status) props['status'] = { value: { code: span.status.code }, enumerable: true };
  return Object.create(span, props) as S;
}

export function wrapSpanExporter<S extends SpanLike>(
  inner: SpanExporterLike<S>,
): SpanExporterLike<S> {
  const wrapped: SpanExporterLike<S> = {
    export: (spans, cb) => inner.export(spans.map(scrubSpan), cb),
    shutdown: () => inner.shutdown(),
  };
  if (inner.forceFlush) {
    const flush = inner.forceFlush.bind(inner);
    return { ...wrapped, forceFlush: flush };
  }
  return wrapped;
}
