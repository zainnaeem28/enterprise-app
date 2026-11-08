import { useRef, useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  LoadingState,
  RefreshingContent,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { Column, FieldError } from '@ehr/ui';
import { useDesk } from './DeskContext.js';
import { PatientPicker } from './PatientPicker.js';
import { ActionError, LoadError } from './Problem.js';
import { PrevisitChips, StatusCell, patientCell, timeColumn, withLabels } from './VisitRows.js';
import { preStrings as p } from './strings.js';
import { nameOf, timeOf } from './format.js';
import { newKey } from './http.js';
import type { Failure } from './http.js';
import { useLoad } from './useLoad.js';
import { useVisitActions } from './useCheckIn.js';
import type { Arrival, FollowUp } from './types.js';

const today = (): string => new Date().toISOString().slice(0, 10);

/** PC-07: follow-up and referral tasks of the location, due date first, with one status step each. */
export function FollowUps() {
  const { api, locationId, can } = useDesk();
  const { state, reload } = useLoad(() => api.followUps(locationId, 'open'), [locationId]);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function step(f: FollowUp, status: 'done' | 'cancelled') {
    if (busy !== null) return;
    setBusy(f.id);
    setNotice(null);
    setFailure(null);
    const r = await api.setFollowUpStatus(f.id, status, f.version);
    setBusy(null);
    if (r.ok) {
      setNotice(p.followUpUpdated);
      reload();
    } else {
      setFailure(r);
      if (r.status === 412 || r.status === 428) reload();
    }
  }

  if (state.kind === 'loading') return <LoadingState label={p.followUpsTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
  const t = today();
  const columns: Column<FollowUp>[] = [
    {
      key: 'due',
      header: p.colDue,
      render: (f) => (
        <>
          {f.dueOn} {f.dueOn < t && <StatusChip tone="danger">{p.overdue}</StatusChip>}
          {f.dueOn === t && <StatusChip tone="warning">{p.dueToday}</StatusChip>}
        </>
      ),
    },
    { key: 'reason', header: p.colReason, render: (f) => f.reason },
    {
      key: 'status',
      header: p.colStatus,
      render: (f) => (
        <StatusChip tone="neutral">
          {f.status === 'open'
            ? p.statusOpen
            : f.status === 'booked'
              ? p.statusBooked
              : f.status === 'done'
                ? p.statusDoneFu
                : p.statusCancelled}
        </StatusChip>
      ),
    },
    {
      key: 'actions',
      header: p.colActions,
      render: (f) =>
        can('clinical.referral.manage') && f.status === 'open' ? (
          <span className="ehr-actions">
            <Button disabled={busy !== null} onClick={() => void step(f, 'done')}>
              {p.markDone}
            </Button>
            <Button disabled={busy !== null} onClick={() => void step(f, 'cancelled')}>
              {p.closeFollowUp}
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <section aria-labelledby="fu-title">
      <div className="ehr-toolbar">
        <h2 id="fu-title">{p.followUpsTitle}</h2>
        <span className="ehr-muted">{p.updatedAt(timeOf(state.updatedAt.toISOString()))}</span>
        <Button onClick={reload}>{p.refresh}</Button>
      </div>
      {notice !== null && (
        <Banner tone="info">
          <p>{notice}</p>
        </Banner>
      )}
      {failure !== null && <ActionError failure={failure} />}
      <RefreshingContent refreshing={state.refreshing}>
        <DataTable
          caption={p.followUpsTitle}
          columns={withLabels(columns)}
          rows={state.data}
          rowKey={(f) => f.id}
          emptyMessage={p.followUpsEmpty}
        />
      </RefreshingContent>
      {can('clinical.referral.manage') && <NewFollowUp onCreated={reload} />}
    </section>
  );
}

/** Pick a patient, then a due date and a reason. The reason is free text the desk keeps free of identifiers (CN-03). */
function NewFollowUp({
  onCreated,
  patient,
}: {
  onCreated: () => void;
  patient?: { id: string; name: string };
}) {
  const { api, locationId } = useDesk();
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(patient ?? null);
  const [dueOn, setDueOn] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef<{ sig: string; key: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: FieldError[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn))
      errs.push({ fieldId: 'fu-due', message: `${p.dueMissing} ${p.dobHint}` });
    if (reason.trim() === '' || reason.length > 500)
      errs.push({ fieldId: 'fu-reason', message: p.reasonMissing });
    setErrors(errs);
    if (errs.length > 0 || chosen === null) return;
    const sig = JSON.stringify([chosen.id, dueOn, reason]);
    if (key.current === null || key.current.sig !== sig) key.current = { sig, key: newKey() };
    setBusy(true);
    setFailure(null);
    const r = await api.createFollowUp(
      chosen.id,
      { locationId, dueOn, reason: reason.trim() },
      key.current.key,
    );
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setDone(true);
      setReason('');
      setDueOn('');
      onCreated();
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
      if (r.fields.includes('dueOn')) setErrors([{ fieldId: 'fu-due', message: p.dueMissing }]);
    }
  }

  return (
    <section aria-labelledby="newfu-title" className="ehr-card">
      <h3 id="newfu-title">{p.createFollowUp}</h3>
      {chosen === null ? (
        <PatientPicker
          idPrefix="fu"
          chooseLabel={p.chooseRecord}
          onChoose={(h) => setChosen({ id: h.id, name: `${h.givenName} ${h.familyName}` })}
        />
      ) : (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <p>
            <strong>{chosen.name}</strong>{' '}
            {patient === undefined && (
              <Button onClick={() => setChosen(null)}>{p.findPatient}</Button>
            )}
          </p>
          <ErrorSummary errors={errors} />
          <TextField
            id="fu-due"
            label={p.dueOn}
            hint={p.dobHint}
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            error={errors.find((x) => x.fieldId === 'fu-due')?.message}
            autoComplete="off"
          />
          <TextAreaField
            id="fu-reason"
            label={p.reason}
            hint={p.reasonHint}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={errors.find((x) => x.fieldId === 'fu-reason')?.message}
            rows={3}
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {p.createFollowUp}
          </Button>
        </form>
      )}
      {failure !== null && <ActionError failure={failure} />}
      {done && (
        <Banner tone="info">
          <p>{p.followUpCreated}</p>
        </Banner>
      )}
    </section>
  );
}

/** PC-08: visits that were not attended: marked no-show, past the grace period, or flagged by the sweep. */
export function NoShows() {
  const { api, locationId, can } = useDesk();
  const { state, reload } = useLoad(() => api.arrivals(locationId), [locationId]);
  const actions = useVisitActions(reload);
  const [forPatient, setForPatient] = useState<{ id: string; name: string } | null>(null);

  if (state.kind === 'loading') return <LoadingState label={p.noShowsTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
  const rows = state.data.filter(
    (a) =>
      a.status === 'no_show' ||
      (a.status === 'confirmed' && (a.noShowCandidate || a.flaggedForStaff)),
  );
  const columns: Column<Arrival>[] = [
    timeColumn,
    { key: 'patient', header: p.colPatient, render: patientCell },
    { key: 'status', header: p.colStatus, render: (a) => <StatusCell a={a} /> },
    {
      key: 'previsit',
      header: p.colPrevisit,
      render: (a) => <PrevisitChips previsit={a.previsit} />,
    },
    {
      key: 'actions',
      header: p.colActions,
      render: (a) => (
        <span className="ehr-actions">
          {can('scheduling.check_in') && a.status === 'confirmed' && (
            <Button
              disabled={actions.busy !== null}
              aria-label={`${p.markNoShow}: ${nameOf(a.patientName)}`}
              onClick={() => void actions.noShow(a)}
            >
              {p.markNoShow}
            </Button>
          )}
          {can('clinical.referral.manage') && (
            <Button
              aria-label={`${p.createFollowUp}: ${nameOf(a.patientName)}`}
              onClick={() => setForPatient({ id: a.patientId, name: nameOf(a.patientName) })}
            >
              {p.createFollowUp}
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <section aria-labelledby="ns-title">
      <div className="ehr-toolbar">
        <h2 id="ns-title">{p.noShowsTitle}</h2>
        <span className="ehr-muted">{p.updatedAt(timeOf(state.updatedAt.toISOString()))}</span>
        <Button onClick={reload}>{p.refresh}</Button>
      </div>
      <p className="ehr-muted">{p.outcomeNote}</p>
      {actions.notice !== null && (
        <Banner tone="info">
          <p>{actions.notice}</p>
        </Banner>
      )}
      {actions.failure !== null && <ActionError failure={actions.failure} />}
      {rows.length === 0 ? (
        <EmptyState message={p.noShowsEmpty} />
      ) : (
        <RefreshingContent refreshing={state.refreshing}>
          <DataTable
            caption={p.noShowsTitle}
            columns={withLabels(columns)}
            rows={rows}
            rowKey={(a) => a.reservationId}
          />
        </RefreshingContent>
      )}
      {forPatient !== null && (
        <NewFollowUp patient={forPatient} onCreated={() => setForPatient(null)} />
      )}
    </section>
  );
}
