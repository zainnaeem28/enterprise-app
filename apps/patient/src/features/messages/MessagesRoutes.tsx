import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  ErrorSummary,
  LoadingState,
  MessageThread,
  PermissionNote,
  RefreshingContent,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { newKey } from '../profile/lib/core.js';
import type { Failure } from '../profile/lib/core.js';
import { summaryOf, useSubmit } from '../profile/lib/forms.js';
import { useAccount, useHeadingFocus, usePageTitle } from '../profile/lib/hooks.js';
import { Problem } from '../profile/lib/Problem.js';
import { createMessagesApi } from './api.js';
import type { MessagesApi } from './api.js';
import type { Thread } from './types.js';
import '../profile/profile.css';

export type MessagesRoute = { name: 'list' } | { name: 'new' } | { name: 'thread'; id: string };

export function matchMessagesRoute(path: string): MessagesRoute | undefined {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (p === '/messages') return { name: 'list' };
  if (p === '/messages/new') return { name: 'new' };
  const m = /^\/messages\/([0-9a-f-]{36})$/i.exec(p);
  return m?.[1] === undefined ? undefined : { name: 'thread', id: m[1].toLowerCase() };
}
export const isMessagesPath = (path: string): boolean => matchMessagesRoute(path) !== undefined;

const when = (iso: string) =>
  iso === ''
    ? ''
    : new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

/**
 * PP-37: messages with the care team. Shown only while the flag `patient_messaging` is on (D-5). With it off the API answers
 * 404 for every call, and this screen reads the same as any page that does not exist, so the flag is not revealed.
 */
export function MessagesRoutes({
  runtime,
  path,
  go,
  recipientPrincipalIds,
}: {
  runtime: PatientRuntime;
  path: string;
  go: (to: string) => void;
  /** Who a new message goes to. No patient route lists recipients yet (README); without it, starting a thread is not offered. */
  recipientPrincipalIds?: string[];
}) {
  const api = useMemo(() => createMessagesApi(runtime), [runtime]);
  const [attempt, setAttempt] = useState(0);
  const { account, failure } = useAccount(runtime, attempt);
  const route = matchMessagesRoute(path);
  if (route === undefined)
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  if (failure !== undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (account === undefined) return <LoadingState label="Loading" lines={3} />;
  if (account.selfId === undefined)
    return (
      <section aria-labelledby="msg-h" className="ehr-card profile">
        <h1 id="msg-h">Messages</h1>
        <PermissionNote scope="Appointments only" />
        <p>Messages belong to the patient. Your account can see appointments only.</p>
      </section>
    );
  return (
    <Inbox
      api={api}
      route={route}
      go={go}
      patientId={account.selfId}
      me={account.principalId}
      recipients={recipientPrincipalIds}
    />
  );
}

function Inbox({
  api,
  route,
  go,
  patientId,
  me,
  recipients,
}: {
  api: MessagesApi;
  route: MessagesRoute;
  go: (to: string) => void;
  patientId: string;
  me: string | undefined;
  recipients: string[] | undefined;
}) {
  const [threads, setThreads] = useState<Thread[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle(route.name === 'new' ? 'New message' : 'Messages');

  const load = useCallback(async () => {
    setRefreshing(true);
    const r = await api.threads(patientId);
    setRefreshing(false);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setThreads(r.data);
  }, [api, patientId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (failure !== undefined && threads === undefined)
    return <Problem failure={failure} onRetry={() => void load()} />;
  if (threads === undefined) return <LoadingState label="Loading your messages" lines={3} />;

  if (route.name === 'new')
    return (
      <NewMessage api={api} patientId={patientId} recipients={recipients} go={go} onSent={load} />
    );

  if (route.name === 'thread') {
    const t = threads.find((x) => x.id === route.id);
    if (t === undefined)
      return <ErrorState kind="not-found" homeHref="/messages" headingLevel={1} />;
    return (
      <section aria-labelledby="msg-h" className="ehr-card profile">
        <h1 id="msg-h" ref={heading} tabIndex={-1}>
          {t.subject}
        </h1>
        {t.status === 'closed' && (
          <Banner tone="info" announce={false}>
            This conversation is closed.
          </Banner>
        )}
        <MessageThread
          label="Messages in this conversation"
          messages={t.messages.map((m) => ({
            id: m.id,
            from: m.authorPrincipalId === me ? 'You' : 'Care team',
            at: when(m.sentAt),
            body: m.body,
            mine: m.authorPrincipalId === me,
          }))}
        />
        <p className="profile-note">To follow up on this conversation, contact your clinic.</p>
        <Button onClick={() => go('/messages')}>Back to messages</Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="msg-h" className="ehr-card profile">
      <h1 id="msg-h" ref={heading} tabIndex={-1}>
        Messages
      </h1>
      <Banner tone="warning" announce={false}>
        Messages are not for emergencies. If you need urgent help, call emergency services.
      </Banner>
      <p>
        <Button variant="primary" onClick={() => go('/messages/new')}>
          Write a message
        </Button>
      </p>
      {threads.length === 0 ? (
        <EmptyState message="No messages yet." />
      ) : (
        <RefreshingContent refreshing={refreshing}>
          <ul className="profile-list">
            {threads.map((t) => (
              <li key={t.id} className="profile-item">
                <p>
                  <a
                    href={`/messages/${t.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(`/messages/${t.id}`);
                    }}
                  >
                    {t.subject}
                  </a>{' '}
                  {t.unread > 0 && <StatusChip tone="info">{t.unread} new</StatusChip>}
                  {t.status === 'closed' && <StatusChip>Closed</StatusChip>}
                </p>
                <p className="profile-note">{when(t.messages.at(-1)?.sentAt ?? '')}</p>
              </li>
            ))}
          </ul>
        </RefreshingContent>
      )}
    </section>
  );
}

function NewMessage({
  api,
  patientId,
  recipients,
  go,
  onSent,
}: {
  api: MessagesApi;
  patientId: string;
  recipients: string[] | undefined;
  go: (to: string) => void;
  onSent: () => Promise<void>;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | undefined>();
  const key = useRef(newKey());
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (recipients === undefined || recipients.length === 0) return;
    const found: Record<string, string> = {};
    if (subject.trim() === '') found['msg-subject'] = 'Subject: enter a short subject.';
    if (body.trim() === '') found['msg-body'] = 'Message: write your message.';
    setErrors(found);
    setFailure(undefined);
    if (Object.keys(found).length > 0) return;
    await run(async () => {
      const r = await api.start(
        patientId,
        { subject: subject.trim(), body: body.trim(), recipientPrincipalIds: recipients },
        key.current,
      );
      if (r.ok) {
        key.current = newKey();
        await onSent();
        return go(`/messages/${r.data.id}`);
      }
      if (r.status === 400)
        return setErrors({
          'msg-body': 'Message: this was not accepted. Shorten it or check the subject.',
        });
      setFailure(r);
    });
  }

  return (
    <section aria-labelledby="new-h" className="ehr-card profile">
      <h1 id="new-h" ref={heading} tabIndex={-1}>
        Write a message
      </h1>
      <Banner tone="warning" announce={false}>
        Messages are not for emergencies. If you need urgent help, call emergency services.
      </Banner>
      {recipients === undefined || recipients.length === 0 ? (
        <>
          <p>To send a message to your care team, contact your clinic.</p>
          <Button onClick={() => go('/messages')}>Back to messages</Button>
        </>
      ) : (
        <>
          <ErrorSummary errors={summaryOf(errors)} />
          {failure !== undefined && (
            <Problem failure={failure} onRetry={() => setFailure(undefined)} />
          )}
          <form onSubmit={(e) => void submit(e)} noValidate aria-label="New message">
            <TextField
              id="msg-subject"
              label="Subject"
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              error={errors['msg-subject']}
            />
            <TextAreaField
              id="msg-body"
              label="Message"
              maxLength={2500}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              error={errors['msg-body']}
            />
            <p className="profile-actions">
              <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
                Send message
              </Button>{' '}
              <Button onClick={() => go('/messages')}>Cancel</Button>
            </p>
          </form>
        </>
      )}
    </section>
  );
}
