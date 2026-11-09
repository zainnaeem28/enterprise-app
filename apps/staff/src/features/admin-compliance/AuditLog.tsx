import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuditTable,
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  FilterBar,
  LoadingState,
  RefreshingContent,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { AuditRow, FieldError } from '@ehr/ui';
import { useElevation } from '../admin-auth/index.js';
import type { Failure } from '../preconsult/http.js';
import { parseDownload, parseExportJob } from './api.js';
import type { AuditFilter } from './api.js';
import { ComplianceContext, UUID, fmtTime, useCompliance } from './context.js';
import { ActionError, LoadError, readAnswer } from './Problem.js';
import { adminStrings as s } from './strings.js';
import type { AuditEvent, ExportJob } from './types.js';

void ComplianceContext;
const DAY = 86_400_000;
const localInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const MINUTE = 60_000;
const POLL_MS = 4000;
/** D5-ext: the untouched default To is the next minute boundary at submit, so current-minute rows are included. */
const nextMinute = (ms: number): number => (Math.floor(ms / MINUTE) + 1) * MINUTE;

type Result =
  | { kind: 'idle' }
  | { kind: 'loading'; previous?: Searched }
  | { kind: 'failed'; failure: Failure }
  | ({ kind: 'ok' } & Searched);
interface Searched {
  events: AuditEvent[];
  truncated: boolean;
  filter: AuditFilter;
  filtered: boolean;
}

function rowOf(e: AuditEvent): AuditRow {
  const record = e.resourceId === null ? e.resourceType : `${e.resourceType} ${e.resourceId}`;
  return {
    id: e.eventId,
    time: fmtTime(e.occurredAt),
    who: e.actorPersonId ?? s.system,
    action: e.action,
    record,
    outcome: e.outcome === 'denied' ? 'denied' : 'allowed',
  };
}

/** AD-01: the audit table with its filters and the export of the search shown (RA-R1-11, RA-R1-12). */
export function AuditLog() {
  const { api } = useCompliance();
  const now = useRef(new Date());
  const [from, setFrom] = useState(() => localInput(new Date(now.current.getTime() - DAY)));
  const [to, setTo] = useState(() => localInput(now.current));
  const [toEdited, setToEdited] = useState(false);
  const [actor, setActor] = useState('');
  const [patient, setPatient] = useState('');
  const [action, setAction] = useState('');
  const [type, setType] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const validate = (): AuditFilter | undefined => {
    const errs: FieldError[] = [];
    const f = Date.parse(from);
    const t = toEdited ? Date.parse(to) : nextMinute(Date.now());
    if (Number.isNaN(f) || Number.isNaN(t)) {
      errs.push({ fieldId: 'audit-from', message: s.rangeMissing });
    } else if (f >= t) errs.push({ fieldId: 'audit-from', message: s.rangeOrder });
    else if (t - f > 31 * DAY) errs.push({ fieldId: 'audit-from', message: s.rangeTooLong });
    if (actor.trim() !== '' && !UUID.test(actor.trim()))
      errs.push({ fieldId: 'audit-actor', message: s.notReference });
    if (patient.trim() !== '' && !UUID.test(patient.trim()))
      errs.push({ fieldId: 'audit-patient', message: s.notReference });
    setErrors(errs);
    if (errs.length > 0) return undefined;
    return {
      from: new Date(f).toISOString(),
      to: new Date(t).toISOString(),
      ...(actor.trim() === '' ? {} : { actorPersonId: actor.trim().toLowerCase() }),
      ...(patient.trim() === '' ? {} : { patientId: patient.trim().toLowerCase() }),
      ...(action.trim() === '' ? {} : { action: action.trim() }),
      ...(type.trim() === '' ? {} : { resourceType: type.trim() }),
    };
  };

  const run = useCallback(
    async (filter: AuditFilter) => {
      setResult((r) => ({ kind: 'loading', ...(r.kind === 'ok' ? { previous: r } : {}) }));
      const out = await api.searchAudit(filter);
      if (!out.ok) return setResult({ kind: 'failed', failure: out });
      setResult({
        kind: 'ok',
        events: out.data.items,
        truncated: out.data.truncated,
        filter,
        filtered:
          filter.actorPersonId !== undefined ||
          filter.patientId !== undefined ||
          filter.action !== undefined ||
          filter.resourceType !== undefined,
      });
    },
    [api],
  );
  const apply = () => {
    const f = validate();
    if (f !== undefined) void run(f);
  };
  const clear = () => {
    setActor('');
    setPatient('');
    setAction('');
    setType('');
    setErrors([]);
  };
  const err = (field: string) => errors.find((e) => e.fieldId === field)?.message;
  const shown =
    result.kind === 'ok' ? result : result.kind === 'loading' ? result.previous : undefined;

  return (
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">{s.auditTitle}</h1>
      <p>{s.auditIntro}</p>
      {errors.length > 0 && <ErrorSummary errors={errors} />}
      <FilterBar label={s.auditTitle} onApply={apply} onClear={clear}>
        <TextField
          id="audit-from"
          label={s.from}
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          {...(err('audit-from') === undefined ? {} : { error: err('audit-from') as string })}
        />
        <TextField
          id="audit-to"
          label={s.to}
          type="datetime-local"
          value={to}
          onChange={(e) => {
            setToEdited(true);
            setTo(e.target.value);
          }}
        />
        <TextField
          id="audit-action"
          label={s.action}
          value={action}
          maxLength={40}
          onChange={(e) => setAction(e.target.value)}
        />
        <TextField
          id="audit-type"
          label={s.resourceType}
          value={type}
          maxLength={100}
          onChange={(e) => setType(e.target.value)}
        />
        <TextField
          id="audit-actor"
          label={s.actor}
          value={actor}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setActor(e.target.value)}
          {...(err('audit-actor') === undefined ? {} : { error: err('audit-actor') as string })}
        />
        <TextField
          id="audit-patient"
          label={s.patient}
          value={patient}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setPatient(e.target.value)}
          {...(err('audit-patient') === undefined ? {} : { error: err('audit-patient') as string })}
        />
      </FilterBar>

      {result.kind === 'idle' && <p>{s.auditIntro}</p>}
      {result.kind === 'loading' && shown === undefined && (
        <LoadingState label={s.loading} lines={5} />
      )}
      {result.kind === 'failed' && <LoadError failure={result.failure} onRetry={apply} />}
      {shown !== undefined && (
        <RefreshingContent refreshing={result.kind === 'loading'}>
          <p role="status">{s.updated(shown.events.length)}</p>
          {shown.truncated && (
            <Banner tone="warning">
              <p>{s.truncated}</p>
            </Banner>
          )}
          {shown.events.length === 0 ? (
            <EmptyState
              message={shown.filtered ? s.auditEmptyFiltered : s.auditEmptyNothing}
              filtered={shown.filtered}
              onClearFilters={clear}
            />
          ) : (
            <AuditTable rows={shown.events.map(rowOf)} />
          )}
          <ExportPanel filter={shown.filter} />
        </RefreshingContent>
      )}
    </section>
  );
}

function ExportPanel({ filter }: { filter: AuditFilter }) {
  const { api } = useCompliance();
  const { callPrivileged } = useElevation();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [job, setJob] = useState<ExportJob | undefined>();
  const [pollFailure, setPollFailure] = useState(false);
  const [opened, setOpened] = useState(false);
  const jobId = job?.id;
  const live = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    if (jobId === undefined || !live) return;
    const t = setInterval(() => {
      void api.exportStatus(jobId).then((o) => {
        if (o.ok) {
          setPollFailure(false);
          setJob(o.data);
        } else setPollFailure(true);
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, jobId, live]);

  const request = async () => {
    if (reason.trim().length < 10 || reason.trim().length > 500) {
      setReasonError(s.exportReasonShort);
      return;
    }
    setReasonError(undefined);
    setFailure(undefined);
    setBusy(true);
    try {
      const answer = await callPrivileged(
        { action: 'Export the audit log', target: s.exportActionTarget, approver: null },
        () => api.requestExportRaw(filter, reason.trim()),
      );
      const r = await readAnswer(answer, (d) => {
        const j = parseExportJob({
          rowCount: null,
          ...(typeof d === 'object' && d !== null ? d : {}),
        });
        return j;
      });
      if (r === undefined) return;
      if (r.ok) {
        setJob(r.data);
        setOpened(false);
        setReason('');
      } else setFailure(r);
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (jobId === undefined) return;
    setFailure(undefined);
    setBusy(true);
    try {
      const answer = await callPrivileged(
        { action: 'Download the audit export', target: s.exportActionTarget, approver: null },
        () => api.downloadRaw(jobId),
      );
      const r = await readAnswer(answer, parseDownload);
      if (r === undefined) return;
      if (r.ok) {
        window.open(r.data.url, '_blank', 'noopener,noreferrer');
        setOpened(true);
      } else setFailure(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="export-title" className="ehr-panel">
      <h2 id="export-title">{s.exportHeading}</h2>
      <p>{s.exportHint}</p>
      <TextAreaField
        id="export-reason"
        label={s.exportReason}
        hint={s.exportReasonHint}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        {...(reasonError === undefined ? {} : { error: reasonError })}
      />
      <Button variant="primary" disabled={busy} onClick={() => void request()}>
        {s.exportAction}
      </Button>
      {failure !== undefined && <ActionError failure={failure} />}
      <div aria-label={s.exportState} role="group">
        {job !== undefined && (
          <Banner
            tone={
              job.status === 'failed' || job.status === 'expired'
                ? 'danger'
                : job.status === 'ready'
                  ? 'info'
                  : 'info'
            }
            announce
          >
            <p>
              {job.status === 'queued' && s.exportQueued}
              {job.status === 'running' && s.exportRunning}
              {job.status === 'ready' && `${s.exportReady} ${s.exportReadyDetail(job.rowCount)}`}
              {job.status === 'failed' && s.exportFailed}
              {job.status === 'expired' && s.exportExpired}
            </p>
            {job.status === 'ready' && (
              <Button variant="primary" disabled={busy} onClick={() => void download()}>
                {s.exportDownload}
              </Button>
            )}
            {pollFailure && live && <p>Status could not be refreshed. Trying again.</p>}
            {opened && <p>{s.exportDownloadOpened}</p>}
          </Banner>
        )}
      </div>
    </section>
  );
}
