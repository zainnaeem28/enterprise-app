import { arr, num, rec, str, strOrNull } from '../preconsult/http.js';

// Shapes copied from the BE-19 service (`apps/api/src/modules/messaging/types.ts`); the generated types of these operations are opaque.
export interface Thread {
  id: string;
  subject: string;
  status: 'open' | 'closed';
  createdAt: string;
  version: number;
  unread: number;
}
export interface ThreadMessage {
  id: string;
  authorPrincipalId: string;
  body: string;
  sentAt: string;
}
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type Assignee =
  | { kind: 'principal'; principalId: string }
  | { kind: 'role_location'; roleKey: string; locationId: string };
export interface Task {
  id: string;
  title: string;
  detail: string | null;
  assignee: Assignee;
  status: TaskStatus;
  dueAt: string | null;
  source: string;
  completedAt: string | null;
  createdAt: string;
  version: number;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function parseThread(v: unknown): Thread | undefined {
  const r = rec(v);
  const id = str(r['id']);
  const subject = str(r['subject']);
  const createdAt = str(r['createdAt']);
  const version = num(r['version']);
  const status = r['status'];
  if (
    id === undefined ||
    subject === undefined ||
    createdAt === undefined ||
    version === undefined ||
    (status !== 'open' && status !== 'closed')
  )
    return undefined;
  return { id, subject, status, createdAt, version, unread: num(r['unread']) ?? 0 };
}

export function parseMessage(v: unknown): ThreadMessage | undefined {
  const r = rec(v);
  const id = str(r['id']);
  const authorPrincipalId = str(r['authorPrincipalId']);
  const body = str(r['body']);
  const sentAt = str(r['sentAt']);
  if (
    id === undefined ||
    authorPrincipalId === undefined ||
    body === undefined ||
    sentAt === undefined
  )
    return undefined;
  return { id, authorPrincipalId, body, sentAt };
}

export function parseTask(v: unknown): Task | undefined {
  const r = rec(v);
  const id = str(r['id']);
  const title = str(r['title']);
  const createdAt = str(r['createdAt']);
  const version = num(r['version']);
  const status = r['status'];
  const a = rec(r['assignee']);
  let assignee: Assignee | undefined;
  if (a['kind'] === 'principal' && str(a['principalId']) !== undefined)
    assignee = { kind: 'principal', principalId: a['principalId'] as string };
  else if (
    a['kind'] === 'role_location' &&
    str(a['roleKey']) !== undefined &&
    str(a['locationId']) !== undefined
  )
    assignee = {
      kind: 'role_location',
      roleKey: a['roleKey'] as string,
      locationId: a['locationId'] as string,
    };
  if (
    id === undefined ||
    title === undefined ||
    createdAt === undefined ||
    version === undefined ||
    assignee === undefined ||
    (status !== 'open' && status !== 'done' && status !== 'cancelled')
  )
    return undefined;
  return {
    id,
    title,
    detail: strOrNull(r['detail']),
    assignee,
    status,
    dueAt: strOrNull(r['dueAt']),
    source: str(r['source']) ?? 'manual',
    completedAt: strOrNull(r['completedAt']),
    createdAt,
    version,
  };
}

export function parsePage<T>(parse: (v: unknown) => T | undefined) {
  return (d: unknown): Page<T> | undefined => {
    const b = rec(d);
    if (!Array.isArray(b['items'])) return undefined;
    const items = arr(b['items']).map(parse);
    if (!items.every((x) => x !== undefined)) return undefined;
    return { items: items as T[], nextCursor: strOrNull(b['nextCursor']) };
  };
}
