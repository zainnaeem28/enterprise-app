// Shapes of the patient messaging views (BE-19 `ThreadView`, `MessageView`). The contract types them as opaque objects.
import { asRecord, str } from '../profile/lib/core.js';

export interface Msg {
  id: string;
  authorPrincipalId: string;
  body: string;
  sentAt: string;
}

export interface Thread {
  id: string;
  subject: string;
  status: 'open' | 'closed';
  unread: number;
  messages: Msg[];
}

export function parseThread(v: unknown): Thread | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const subject = str(o['subject']);
  if (id === undefined || subject === undefined) return undefined;
  const messages = Array.isArray(o['messages'])
    ? o['messages']
        .map(asRecord)
        .filter((m) => str(m['id']) !== undefined && str(m['body']) !== undefined)
        .map((m) => ({
          id: m['id'] as string,
          authorPrincipalId: str(m['authorPrincipalId']) ?? '',
          body: m['body'] as string,
          sentAt: str(m['sentAt']) ?? '',
        }))
    : [];
  return {
    id,
    subject,
    status: o['status'] === 'closed' ? 'closed' : 'open',
    unread: typeof o['unread'] === 'number' ? o['unread'] : 0,
    messages,
  };
}
