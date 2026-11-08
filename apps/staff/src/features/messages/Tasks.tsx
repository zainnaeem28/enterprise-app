import { useRef, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  LoadingState,
  PermissionNote,
  SelectField,
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
import type { Task, TaskStatus } from './types.js';

const MAX_TITLE = 200;
const MAX_DETAIL = 5120;

function NewTask({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { api, principalId, locationIds, online } = useMessages();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [due, setDue] = useState('');
  const [who, setWho] = useState<'me' | 'role'>('me');
  const [roleKey, setRoleKey] = useState('');
  const [locationId, setLocationId] = useState(locationIds[0] ?? '');
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
    const found: FieldError[] = [];
    if (title.trim() === '' || title.length > MAX_TITLE)
      found.push({ fieldId: 'task-title', message: s.errTitle });
    const dueAt = due === '' ? null : new Date(due);
    if (dueAt !== null && Number.isNaN(dueAt.getTime()))
      found.push({ fieldId: 'task-due', message: s.errDue });
    if (who === 'role') {
      if (roleKey.trim() === '') found.push({ fieldId: 'task-role', message: s.errRole });
      if (locationId === '') found.push({ fieldId: 'task-location', message: s.errLocation });
    }
    setErrors(found);
    if (found.length > 0) return;
    setBusy(true);
    const out = await api.createTask(
      {
        title: title.trim(),
        detail: detail.trim().slice(0, MAX_DETAIL),
        dueAt: dueAt === null ? null : dueAt.toISOString(),
        assignee: who === 'me' ? { principalId } : { roleKey: roleKey.trim(), locationId },
      },
      key.current,
    );
    setBusy(false);
    if (!out.ok) return setFailure(out);
    onDone();
  };

  return (
    <form
      aria-label={s.newTaskTitle}
      noValidate
      className="ehr-msg-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{s.newTaskTitle}</h3>
      <ErrorSummary title={s.fixErrors} errors={errors} />
      {failure !== null && <ActionError failure={failure} />}
      <TextField
        id="task-title"
        label={s.taskTitle}
        maxLength={MAX_TITLE}
        value={title}
        onChange={(e) => edit(() => setTitle(e.target.value))}
      />
      <TextAreaField
        id="task-detail"
        label={s.taskDetail}
        hint={s.taskDetailHint}
        rows={3}
        value={detail}
        onChange={(e) => edit(() => setDetail(e.target.value))}
      />
      <TextField
        id="task-due"
        label={s.taskDue}
        type="datetime-local"
        value={due}
        onChange={(e) => edit(() => setDue(e.target.value))}
      />
      <SelectField
        id="task-assign"
        label={s.taskAssign}
        value={who}
        onChange={(e) => edit(() => setWho(e.target.value as 'me' | 'role'))}
      >
        <option value="me">{s.assignMe}</option>
        <option value="role">{s.assignRole}</option>
      </SelectField>
      {who === 'role' && (
        <>
          <TextField
            id="task-role"
            label={s.roleKey}
            hint={s.roleKeyHint}
            autoComplete="off"
            value={roleKey}
            onChange={(e) => edit(() => setRoleKey(e.target.value))}
          />
          <SelectField
            id="task-location"
            label={s.location}
            value={locationId}
            onChange={(e) => edit(() => setLocationId(e.target.value))}
          >
            {locationIds.map((l, i) => (
              <option key={l} value={l}>
                {s.locationN(i + 1)}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {!online && <p className="ehr-muted">{s.offlineWrites}</p>}
      <div className="ehr-msg-actions">
        <Button variant="primary" type="submit" disabled={!online || busy}>
          {s.createTask}
        </Button>
        <Button onClick={onCancel}>{s.cancel}</Button>
      </div>
    </form>
  );
}

function assigneeText(t: Task, me: string): string {
  if (t.assignee.kind === 'role_location') return s.assignedRole(t.assignee.roleKey);
  return t.assignee.principalId === me ? s.assignedMe : s.assignedOther;
}

/** DR-08, tasks: create a task for yourself or a role at a location, and mark tasks done. Cancelling is the creator's and is not offered here. */
export function Tasks() {
  const { api, can, principalId, online } = useMessages();
  const allowed = can('messaging.task.manage');
  const [status, setStatus] = useState<TaskStatus>('open');
  const { state, reload } = useLoad(() => api.tasks(status), [status], allowed);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!allowed) return <PermissionNote scope={s.noPermission} />;

  const complete = async (t: Task) => {
    setFailure(null);
    setNotice(null);
    setBusyId(t.id);
    const out = await api.completeTask(t);
    setBusyId(null);
    if (!out.ok) {
      setFailure(out);
      if (out.status === 412 || out.status === 428 || out.status === 404) reload();
      return;
    }
    setNotice(s.completed);
    reload();
  };

  let body;
  if (state.kind === 'loading') body = <LoadingState label={s.tasksTitle} lines={4} />;
  else if (state.kind === 'error') body = <LoadError failure={state.failure} onRetry={reload} />;
  else if (state.data.items.length === 0)
    body = <EmptyState message={s.noTasks(s.statusLabel[status].toLowerCase())} />;
  else
    body = (
      <ul aria-label={s.taskListLabel} className="ehr-msg-tasks">
        {state.data.items.map((t) => (
          <li key={t.id} className="ehr-card">
            <strong>{t.title}</strong>{' '}
            <StatusChip tone={t.status === 'open' ? 'info' : 'neutral'}>
              {s.statusLabel[t.status]}
            </StatusChip>
            {t.detail !== null && <p>{t.detail}</p>}
            <p className="ehr-muted">
              {assigneeText(t, principalId)}
              {t.dueAt !== null && ` · ${s.due(dateTimeOf(t.dueAt))}`}
              {t.completedAt !== null && ` · ${s.doneAt(dateTimeOf(t.completedAt))}`}
            </p>
            {t.status === 'open' && (
              <Button
                aria-label={s.completeLabel(t.title)}
                disabled={!online || busyId === t.id}
                onClick={() => void complete(t)}
              >
                {s.complete}
              </Button>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-labelledby="task-title-h" className="ehr-msg">
      <h2 id="task-title-h">{s.tasksTitle}</h2>
      {notice !== null && (
        <Banner tone="info">
          <p>{notice}</p>
        </Banner>
      )}
      {failure !== null && <ActionError failure={failure} />}
      {creating ? (
        <NewTask
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            setNotice(s.taskCreated);
            if (status === 'open') reload();
            else setStatus('open');
          }}
        />
      ) : (
        <div className="ehr-msg-actions">
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!online}>
            {s.newTask}
          </Button>
          <SelectField
            id="task-filter"
            label={s.filterLabel}
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            <option value="open">{s.filterOpen}</option>
            <option value="done">{s.filterDone}</option>
            <option value="cancelled">{s.filterCancelled}</option>
          </SelectField>
          <Button onClick={reload}>{s.refresh}</Button>
        </div>
      )}
      {body}
    </section>
  );
}
