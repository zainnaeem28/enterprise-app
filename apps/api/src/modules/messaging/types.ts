export type ThreadKind = 'staff' | 'patient';
export type ThreadStatus = 'open' | 'closed';
export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskSource =
  'manual' | 'privacy_correction' | 'no_show_follow_up' | 'note_sign_deadline';

export interface RequestMeta {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ThreadView {
  id: string;
  kind: ThreadKind;
  patientId: string | null;
  subject: string;
  status: ThreadStatus;
  locationId: string | null;
  createdAt: string;
  version: number;
  /** The caller's own participant row (the policy shows a caller only their own, 22.12); null for a creator not yet a participant. */
  me: { role: 'member' | 'owner'; lastReadAt: string | null } | null;
  /** Messages after the caller's read mark. */
  unread: number;
  /** Patient route only: the thread's messages, oldest first. */
  messages?: MessageView[];
}

export interface MessageView {
  id: string;
  threadId: string;
  authorPrincipalId: string;
  body: string;
  attachmentDocumentIds: string[];
  sentAt: string;
}

export interface TaskView {
  id: string;
  patientId: string | null;
  title: string;
  detail: string | null;
  assignee:
    | { kind: 'principal'; principalId: string }
    | { kind: 'role_location'; roleKey: string; locationId: string };
  status: TaskStatus;
  dueAt: string | null;
  source: TaskSource;
  completedAt: string | null;
  createdAt: string;
  version: number;
}

/** What the controller passes of the session: the roles that decide who may act on a role-at-location task. */
export interface CallerRoles {
  roles: readonly { key: string; locationId?: string }[];
}
