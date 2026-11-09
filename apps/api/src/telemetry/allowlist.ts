// What may leave the API process as telemetry (DEVOPS-PLAN 11.1, NFR-18). Anything not listed is dropped.
// The key list is mirrored in infra/modules/observability/adot/allowed-attributes.json (the collector's allowlist);
// telemetry.test.ts fails if the two differ.

export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'service.name',
  'service.version',
  'deployment.environment.name',
  'cloud.provider',
  'cloud.region',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'network.protocol.version',
  'error.type',
  'exception.type',
  'db.system',
  'db.operation.name',
  'messaging.system',
  'messaging.operation.type',
  'ehr.request_id',
  'ehr.release_number',
  'ehr.route_permission',
  'ehr.job_type',
  'ehr.queue',
  'ehr.outbox_event_type',
  'ehr.integration_vendor',
  'ehr.audience',
]);

/** Value shapes that must never appear in a telemetry attribute, even under an allowed key. */
export const BLOCKED_VALUE_PATTERNS: readonly RegExp[] = [
  /PHI-CANARY-[A-Z0-9]{8,}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/,
  /\b(?:\+?1[ -.]?)?\(?[0-9]{3}\)?[ -.][0-9]{3}[ -.][0-9]{4}\b/,
  /\b(?:[0-9][ -]?){13,19}\b/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}/,
  /(dob|date_of_birth|birth_date)\W{1,3}(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}/i,
];

export const REDACTED = '[redacted]';
export const MAX_VALUE_LENGTH = 256;
