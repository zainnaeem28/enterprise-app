import { guard, matchHeader } from '../preconsult/http.js';
import type { Api, Outcome } from '../preconsult/http.js';
import { parseMessage, parsePage, parseTask, parseThread } from './types.js';
import type { Page, Task, Thread, ThreadMessage } from './types.js';

type Method = 'GET' | 'POST' | 'PATCH';
type LooseCall = (
  path: string,
  init: {
    params: {
      header: Record<string, string>;
      path?: Record<string, string>;
      query?: Record<string, string>;
    };
    body?: unknown;
  },
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

export interface TaskDraft {
  title: string;
  detail: string;
  dueAt: string | null;
  assignee: { principalId: string } | { roleKey: string; locationId: string };
}
export interface ThreadDraft {
  subject: string;
  body: string;
  participantIds: string[];
}

/**
 * Every call the messages and tasks screens make, over the shell's client (CSRF and release headers come from the shell). The generated
 * request and response types of these operations are opaque, so the calls go through the untyped seam the other staff features use,
 * with the bodies of the BE-19 controller. Writes that create carry one `Idempotency-Key` per attempt; a task change carries the
 * version we hold as `If-Match`, never an invented one.
 */
export function createMessagesApi(api: Api) {
  const header = api.header;
  const loose = api as unknown as Record<Method, LooseCall>;
  const keyed = (key: string) => ({ ...header, 'Idempotency-Key': key });
  const paged = (cursor?: string) => ({ limit: '50', ...(cursor === undefined ? {} : { cursor }) });

  return {
    threads: (cursor?: string): Promise<Outcome<Page<Thread>>> =>
      guard(
        () => loose.GET('/api/v1/threads', { params: { header, query: paged(cursor) } }),
        parsePage(parseThread),
      ),
    messages: (threadId: string, cursor?: string): Promise<Outcome<Page<ThreadMessage>>> =>
      guard(
        () =>
          loose.GET('/api/v1/threads/{id}/messages', {
            params: { header, path: { id: threadId }, query: paged(cursor) },
          }),
        parsePage(parseMessage),
      ),
    createThread: (d: ThreadDraft, key: string): Promise<Outcome<Thread>> =>
      guard(
        () =>
          loose.POST('/api/v1/threads', {
            params: { header: keyed(key) },
            body: {
              subject: d.subject,
              body: d.body,
              ...(d.participantIds.length === 0 ? {} : { participantIds: d.participantIds }),
            },
          }),
        parseThread,
      ),
    sendMessage: (threadId: string, body: string, key: string): Promise<Outcome<ThreadMessage>> =>
      guard(
        () =>
          loose.POST('/api/v1/threads/{id}/messages', {
            params: { header: keyed(key), path: { id: threadId } },
            body: { body },
          }),
        parseMessage,
      ),
    tasks: (status: string, cursor?: string): Promise<Outcome<Page<Task>>> =>
      guard(
        () =>
          loose.GET('/api/v1/tasks', { params: { header, query: { ...paged(cursor), status } } }),
        parsePage(parseTask),
      ),
    createTask: (d: TaskDraft, key: string): Promise<Outcome<Task>> =>
      guard(
        () =>
          loose.POST('/api/v1/tasks', {
            params: { header: keyed(key) },
            body: {
              title: d.title,
              ...(d.detail === '' ? {} : { detail: d.detail }),
              ...(d.dueAt === null ? {} : { dueAt: d.dueAt }),
              assignee: d.assignee,
            },
          }),
        parseTask,
      ),
    completeTask: (task: Task): Promise<Outcome<Task>> =>
      guard(
        () =>
          loose.PATCH('/api/v1/tasks/{id}', {
            params: { header: { ...header, ...matchHeader(task.version) }, path: { id: task.id } },
            body: { status: 'done' },
          }),
        parseTask,
      ),
  };
}
export type MessagesApi = ReturnType<typeof createMessagesApi>;
