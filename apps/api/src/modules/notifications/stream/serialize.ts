// The stream event serialiser (ARCHITECTURE 32.1, SEC-01 ST-2). The data of an event is a CLOSED field list: IDs, a category
// (`type`, `severity`), times, the two escalation fields and a portal path with IDs only. Never a patient name, date of birth,
// record number, condition or alert text. Every event goes through these functions; a schema test pins the field lists.
import type { AlertView } from '../alerts/types.js';

export const ALERT_EVENT_FIELDS = [
  'alertId',
  'seq',
  'type',
  'severity',
  'createdAt',
  'escalationLevel',
  'escalatesAt',
  'link',
] as const;
export const ALERT_CLOSED_EVENT_FIELDS = ['alertId', 'seq'] as const;

/** `id:` is the alert's `seq` (32.1), so the browser's `Last-Event-ID` is the replay cursor. */
export function alertEvent(a: AlertView): string {
  const data = {
    alertId: a.alertId,
    seq: a.seq,
    type: a.type,
    severity: a.severity,
    createdAt: a.createdAt,
    escalationLevel: a.escalationLevel,
    escalatesAt: a.escalatesAt,
    link: a.link,
  };
  return `id: ${a.seq}\nevent: alert\ndata: ${JSON.stringify(data)}\n\n`;
}

export function alertClosedEvent(alertId: string, seq: number): string {
  return `event: alert_closed\ndata: ${JSON.stringify({ alertId, seq })}\n\n`;
}

export const PING_EVENT = 'event: ping\ndata:\n\n';
export const RESYNC_EVENT = 'event: resync\ndata: {}\n\n';
export const CLOSED_EVENT = 'event: closed\ndata: {}\n\n';
export const RETRY_FRAME = 'retry: 5000\n\n';
