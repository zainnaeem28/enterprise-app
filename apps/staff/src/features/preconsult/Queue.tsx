import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  LoadingState,
  RefreshingContent,
  SelectField,
  StatusChip,
} from '@ehr/ui';
import type { Column } from '@ehr/ui';
import { useDesk, selection } from './DeskContext.js';
import { ActionError, LoadError } from './Problem.js';
import { withLabels } from './VisitRows.js';
import { preStrings as p } from './strings.js';
import { categoryLabel, nameOf, stageLabel, timeOf, waitText } from './format.js';
import { useLoad } from './useLoad.js';
import type { Failure } from './http.js';
import { QUEUE_STAGES, arrivalFromQueue } from './types.js';
import type { QueueEntry, QueueStage } from './types.js';

/** Queue with stage and waiting time (TC-PC-05: waiting time is now minus arrival). The clock below only redraws; it makes no request. */
export function Queue() {
  const { api, locationId, can, showTab } = useDesk();
  const { state, reload } = useLoad(() => api.queue(locationId), [locationId]);
  const [rows, setRows] = useState<QueueEntry[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, QueueStage>>({});
  const loadedAt = useRef(Date.now());

  useEffect(() => {
    if (state.kind === 'ready') {
      setRows(state.data);
      loadedAt.current = state.updatedAt.getTime();
      setNow(Date.now());
    }
  }, [state]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (state.kind === 'loading' || rows === null) {
    if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
    return <LoadingState label={p.queueTitle} lines={4} />;
  }

  async function move(e: QueueEntry) {
    const stage = pick[e.id];
    if (stage === undefined || stage === e.stage || busy !== null) return;
    setBusy(e.id);
    setNotice(null);
    setFailure(null);
    const r = await api.setStage(e.id, stage, e.version);
    setBusy(null);
    if (r.ok) {
      // Keep the waiting time: the answer is recomputed server side, but a stage change does not restart the wait.
      setRows((cur) => (cur ?? []).map((x) => (x.id === e.id ? { ...r.data } : x)));
      setNotice(p.moved(nameOf(e.patientName), stageLabel[stage]));
    } else {
      setFailure(r);
      if (r.status === 412 || r.status === 428) reload();
    }
  }

  const elapsed = Math.max(0, Math.floor((now - loadedAt.current) / 1000));
  const manage = can('scheduling.queue.manage');
  const columns: Column<QueueEntry>[] = [
    {
      key: 'patient',
      header: p.colPatient,
      render: (e) => <strong>{nameOf(e.patientName)}</strong>,
    },
    {
      key: 'stage',
      header: p.stage,
      render: (e) => (
        <>
          <StatusChip tone={e.stage === 'ready' ? 'success' : 'neutral'}>
            {stageLabel[e.stage]}
          </StatusChip>{' '}
          {e.triageCategory !== null && (
            <StatusChip
              tone={
                e.triageCategory === 'emergency' || e.triageCategory === 'urgent'
                  ? 'danger'
                  : 'neutral'
              }
            >
              {categoryLabel[e.triageCategory]}
            </StatusChip>
          )}
        </>
      ),
    },
    {
      key: 'wait',
      header: p.colWait,
      render: (e) =>
        e.stage === 'done' || e.stage === 'with_clinician'
          ? '—'
          : waitText(e.waitSeconds + elapsed),
    },
    {
      key: 'doctor',
      header: p.doctorAssigned,
      render: (e) => (e.assignedClinicianId === null ? p.doctorNotAssigned : p.doctorAssigned),
    },
    {
      key: 'actions',
      header: p.colActions,
      render: (e) => (
        <span className="ehr-actions">
          {manage && (
            <>
              <SelectField
                label={p.moveTo}
                value={pick[e.id] ?? e.stage}
                onChange={(ev) => setPick({ ...pick, [e.id]: ev.target.value as QueueStage })}
              >
                {QUEUE_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {stageLabel[s]}
                  </option>
                ))}
              </SelectField>
              <Button
                disabled={busy !== null || (pick[e.id] ?? e.stage) === e.stage}
                aria-label={`${p.move}: ${nameOf(e.patientName)}`}
                onClick={() => void move(e)}
              >
                {p.move}
              </Button>
            </>
          )}
          {can('clinical.vitals.record') && (
            <Button
              onClick={() => {
                selection.set(arrivalFromQueue(e));
                showTab('triage');
              }}
            >
              {p.openTriage}
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="queue-title">
      <div className="ehr-toolbar">
        <h2 id="queue-title">{p.queueTitle}</h2>
        <span className="ehr-muted">
          {p.updatedAt(
            timeOf(
              state.kind === 'ready' ? state.updatedAt.toISOString() : new Date().toISOString(),
            ),
          )}
        </span>
        <Button onClick={reload}>{p.refresh}</Button>
      </div>
      <p className="ehr-muted">{p.waitAsOf}</p>
      {notice !== null && (
        <Banner tone="info">
          <p>{notice}</p>
        </Banner>
      )}
      {failure !== null && <ActionError failure={failure} />}
      <RefreshingContent refreshing={state.kind === 'ready' && state.refreshing}>
        <DataTable
          caption={p.queueTitle}
          columns={withLabels(columns)}
          rows={rows}
          rowKey={(e) => e.id}
          emptyMessage={p.queueEmpty}
        />
      </RefreshingContent>
    </section>
  );
}
