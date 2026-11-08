// Public surface of the alert stream (ARCHITECTURE 32). Other modules import only from here.
export {
  MAX_STREAMS_PER_PRINCIPAL,
  MAX_STREAMS_PER_SESSION,
  PING_MS,
  REPLAY_LIMIT,
  REVALIDATE_MS,
  StreamHub,
  WRITE_BUFFER_LIMIT,
  parseLastEventId,
  parsePayload,
} from './hub.js';
export type { HubDeps, ListenClient, StreamIdentity, StreamResponse } from './hub.js';
export { createAlertStreamController } from './controller.js';
export type { IdentityOf } from './controller.js';
export {
  ALERT_CLOSED_EVENT_FIELDS,
  ALERT_EVENT_FIELDS,
  alertClosedEvent,
  alertEvent,
} from './serialize.js';
