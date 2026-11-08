import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  LoadingState,
  MessageThread,
  PermissionNote,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useMessages } from './MessagesContext.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import { newKey } from '../preconsult/http.js';
import type { Failure } from '../preconsult/http.js';
import { dateTimeOf } from '../doctor/format.js';
import { msgStrings as s } from './strings.js';
import type { Thread, ThreadMessage } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBJECT = 200;
const MAX_BODY = 10240;

function ThreadView({ thread, onBack }: { thread: Thread; onBack: () => void }) {
  const { api, principalId, online } = useMessages();
  const { state, reload } = useLoad(() => api.messages(thread.id), [thread.id]);
  const [older, setOlder] = useState<ThreadMessage[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const key = useRef(newKey());
  const heading = useRef<HTMLHeadingElement>(null);

  const ready = state.kind === 'ready';
  useEffect(() => {
    if (ready) heading.current?.focus();
  }, [thread.id, ready]);
  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
    setBody('');
    setDone(false);
  }, [thread.id]);

  if (state.kind === 'loading') return <LoadingState label={thread.subject} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;

  const next = cursor === undefined ? state.data.nextCursor : cursor;
  const loadMore = async () => {
    if (next === null) return;
    const out = await api.messages(thread.id, next);
    if (out.ok) {
      setOlder((o) => [...o, ...out.data.items]);
      setCursor(out.data.nextCursor);
    } else setFailure(out);
  };
  const all = [...state.data.items, ...older].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const rows = all.map((m) => ({
    id: m.id,
    from: m.authorPrincipalId === principalId ? s.you : s.colleague,
    at: dateTimeOf(m.sentAt),
    body: m.body,
    mine: m.authorPrincipalId === principalId,
  }));

  const send = async () => {
    const text = body.trim();
    if (text === '' || text.length > MAX_BODY) {
      setErrors([{ fieldId: 'msg-reply', message: text === '' ? s.errReply : s.errTooLong }]);
      return;
    }
    setErrors([]);
    setFailure(null);
    setBusy(true);
    const out = await api.sendMessage(thread.id, text, key.current);
    setBusy(false);
    if (!out.ok) return setFailure(out);
    key.current = newKey();
    setBody('');
    setDone(true);
    reload();
  };

  return (
    <section aria-labelledby="msg-thread-title" className="ehr-msg-detail">
      <Button className="ehr-msg-back" onClick={onBack}>
        {s.back}
      </Button>
      <h3 id="msg-thread-title" tabIndex={-1} ref={heading}>
        {thread.subject}
      </h3>
      {thread.status === 'closed' && <StatusChip tone="neutral">{s.closedChip}</StatusChip>}
      {all.length === 0 ? (
        <EmptyState message={s.noMessages} />
      ) : (
        <MessageThread messages={rows} label={s.threadLabel(thread.subject)} />
      )}
      {next !== null && <Button onClick={() => void loadMore()}>{s.loadOlder}</Button>}
      {thread.status === 'closed' ? (
        <p className="ehr-muted">{s.closedNoReply}</p>
      ) : (
        <form
          aria-label={s.replyForm}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <ErrorSummary title={s.fixErrors} errors={errors} />
          {failure !== null && <ActionError failure={failure} />}
          {done && (
            <Banner tone="info">
              <p>{s.sent}</p>
            </Banner>
          )}
          <TextAreaField
            id="msg-reply"
            label={s.replyLabel}
            rows={3}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setDone(false);
              setFailure(null);
              key.current = newKey();
            }}
          />
          {!online && <p className="ehr-muted">{s.offlineWrites}</p>}
          <Button variant="primary" type="submit" disabled={!online || busy}>
            {s.send}
          </Button>
        </form>
      )}
    </section>
  );
}

function NewThread({ onDone, onCancel }: { onDone: (t: Thread) => void; onCancel: () => void }) {
  const { api, online } = useMessages();
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const edit = (f: () => void) => {
    f();
    setFailure(null);
    key.current = newKey();
  };

  const submit = async () => {
    const ids = to.split(/[\s,;]+/).filter((x) => x !== '');
    const found: FieldError[] = [];
    if (subject.trim() === '' || subject.length > MAX_SUBJECT)
      found.push({ fieldId: 'msg-subject', message: s.errSubject });
    if (text.trim() === '') found.push({ fieldId: 'msg-first', message: s.errReply });
    else if (text.length > MAX_BODY) found.push({ fieldId: 'msg-first', message: s.errTooLong });
    if (!ids.every((i) => UUID.test(i))) found.push({ fieldId: 'msg-to', message: s.errRecipient });
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    const out = await api.createThread(
      { subject: subject.trim(), body: text.trim(), participantIds: ids },
      key.current,
    );
    setBusy(false);
    if (!out.ok) return setFailure(out);
    onDone(out.data);
  };

  return (
    <section aria-labelledby="msg-new-title" className="ehr-msg-detail">
      <h3 id="msg-new-title">{s.newThreadTitle}</h3>
      <form
        aria-label={s.newThreadTitle}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ErrorSummary title={s.fixErrors} errors={errors} />
        {failure !== null && <ActionError failure={failure} />}
        <TextField
          id="msg-subject"
          label={s.subject}
          hint={s.subjectHint}
          maxLength={MAX_SUBJECT}
          value={subject}
          onChange={(e) => edit(() => setSubject(e.target.value))}
        />
        <TextField
          id="msg-to"
          label={s.recipients}
          hint={s.recipientsHint}
          autoComplete="off"
          value={to}
          onChange={(e) => edit(() => setTo(e.target.value))}
        />
        <TextAreaField
          id="msg-first"
          label={s.firstMessage}
          rows={4}
          value={text}
          onChange={(e) => edit(() => setText(e.target.value))}
        />
        {!online && <p className="ehr-muted">{s.offlineWrites}</p>}
        <div className="ehr-msg-actions">
          <Button variant="primary" type="submit" disabled={!online || busy}>
            {s.createThread}
          </Button>
          <Button onClick={onCancel}>{s.cancel}</Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Secure staff messages as a list-detail pattern (UI-UX 6, 12): list and thread side by side on a wide screen, one at a time on a
 * narrow one (a Back button returns to the list and focus moves to the thread heading on open).
 */
export function Threads() {
  const { api, can, online } = useMessages();
  const allowed = can('messaging.thread.staff');
  const { state, reload } = useLoad(() => api.threads(), [], allowed);
  const [more, setMore] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<
    { kind: 'none' } | { kind: 'new' } | { kind: 'open'; id: string }
  >({ kind: 'none' });
  const [created, setCreated] = useState<Thread | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const back = useCallback(() => setMode({ kind: 'none' }), []);

  if (!allowed) return <PermissionNote scope={s.noPermission} />;
  if (state.kind === 'loading') return <LoadingState label={s.messagesTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;

  const base = state.data.items;
  const loaded = [
    ...(created !== null && !base.some((t) => t.id === created.id) ? [created] : []),
    ...base,
    ...more,
  ];
  const next = cursor === undefined ? state.data.nextCursor : cursor;
  const open = mode.kind === 'open' ? loaded.find((t) => t.id === mode.id) : undefined;
  const detailShown = mode.kind === 'new' || open !== undefined;

  return (
    <section aria-labelledby="msg-title" className="ehr-msg" data-detail={detailShown}>
      <h2 id="msg-title">{s.messagesTitle}</h2>
      {notice !== null && (
        <Banner tone="info">
          <p>{notice}</p>
        </Banner>
      )}
      <div className="ehr-msg-panes">
        <div className="ehr-msg-list">
          <div className="ehr-msg-actions">
            <Button variant="primary" onClick={() => setMode({ kind: 'new' })} disabled={!online}>
              {s.newThread}
            </Button>
            <Button
              onClick={() => {
                setMore([]);
                setCursor(undefined);
                setCreated(null);
                reload();
              }}
            >
              {s.refresh}
            </Button>
          </div>
          {loaded.length === 0 ? (
            <EmptyState message={s.noThreads} />
          ) : (
            <ul aria-label={s.threadListLabel} className="ehr-msg-threads">
              {loaded.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="ehr-msg-row"
                    aria-current={open?.id === t.id ? 'true' : undefined}
                    onClick={() => {
                      setNotice(null);
                      setMode({ kind: 'open', id: t.id });
                    }}
                  >
                    <strong>{t.subject}</strong>
                    <span className="ehr-muted">{dateTimeOf(t.createdAt)}</span>
                    {t.unread > 0 && <StatusChip tone="info">{s.unreadN(t.unread)}</StatusChip>}
                    {t.status === 'closed' && (
                      <StatusChip tone="neutral">{s.closedChip}</StatusChip>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {next !== null && (
            <Button
              onClick={() =>
                void api.threads(next).then((o) => {
                  if (!o.ok) return;
                  setMore((m) => [...m, ...o.data.items]);
                  setCursor(o.data.nextCursor);
                })
              }
            >
              {s.loadMoreThreads}
            </Button>
          )}
        </div>
        <div className="ehr-msg-pane">
          {mode.kind === 'new' ? (
            <NewThread
              onCancel={back}
              onDone={(t) => {
                setCreated(t);
                setNotice(s.threadCreated);
                setMode({ kind: 'open', id: t.id });
              }}
            />
          ) : open !== undefined ? (
            <ThreadView thread={open} onBack={back} />
          ) : (
            <p className="ehr-muted ehr-msg-empty">{s.pickThread}</p>
          )}
        </div>
      </div>
    </section>
  );
}
