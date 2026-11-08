import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ConfirmRiskDialog,
  EmptyState,
  ErrorSummary,
  LoadingState,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useDesk } from './DeskContext.js';
import { PatientPicker } from './PatientPicker.js';
import { ActionError, LoadError } from './Problem.js';
import { preStrings as p } from './strings.js';
import { newKey } from './http.js';
import type { Failure } from './http.js';
import { useLoad } from './useLoad.js';
import type { MergeRequest, PatientHit } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PC duplicate queue: open flags at the location. A flag whose other record is outside the user's scope names no one (UI-UX 7.3). */
export function DuplicateFlags({ onMerge }: { onMerge: (a: string, b: string) => void }) {
  const { api, locationId, can } = useDesk();
  const { state, reload } = useLoad(() => api.duplicateFlags(locationId), [locationId]);
  if (state.kind === 'loading') return <LoadingState label={p.dupQueueTitle} lines={3} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
  return (
    <section aria-labelledby="flags-title">
      <div className="ehr-toolbar">
        <h2 id="flags-title">{p.dupQueueTitle}</h2>
        <Button onClick={reload}>{p.refresh}</Button>
      </div>
      {state.data.length === 0 ? (
        <EmptyState message={p.dupQueueEmpty} />
      ) : (
        <ul className="ehr-plain-list" aria-label={p.dupQueueTitle}>
          {state.data.map((f) => (
            <li key={f.id} className="ehr-card">
              <StatusChip tone={f.strength === 'exact' ? 'danger' : 'warning'}>
                {f.strength === 'exact' ? p.dupStrengthExact : p.dupStrengthProbable}
              </StatusChip>{' '}
              <span className="ehr-muted">{f.createdAt.slice(0, 10)}</span>{' '}
              {f.candidatePatientId === null ? (
                <span>{p.dupCandidateHidden}</span>
              ) : (
                can('patient.merge.request') && (
                  <Button onClick={() => onMerge(f.patientId, f.candidatePatientId as string)}>
                    {p.dupStartMerge}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Merge tab: request (needs `patient.merge.request`) and decide (needs `patient.merge.approve`). Neither permission: no merge control at all. */
export function Merge({ preset }: { preset: { survivorId: string; mergedId: string } | null }) {
  const { can } = useDesk();
  const request = can('patient.merge.request');
  const approve = can('patient.merge.approve');
  if (!request && !approve)
    return (
      <section aria-labelledby="merge-title">
        <h2 id="merge-title">{p.tabMerge}</h2>
        <p>{p.noMergeAction}</p>
      </section>
    );
  return (
    <section aria-labelledby="merge-title">
      <h2 id="merge-title">{p.tabMerge}</h2>
      {request && <MergeRequestForm preset={preset} />}
      {approve && <MergeDecision />}
    </section>
  );
}

function RecordLine({ r, label }: { r: PatientHit | null; label: string }) {
  return (
    <p>
      <strong>{label}: </strong>
      {r === null ? p.chooseRecord : `${r.givenName} ${r.familyName} · ${r.mrn} · ${r.dateOfBirth}`}
    </p>
  );
}

function MergeRequestForm({ preset }: { preset: { survivorId: string; mergedId: string } | null }) {
  const { api } = useDesk();
  const [survivor, setSurvivor] = useState<PatientHit | null>(null);
  const [merged, setMerged] = useState<PatientHit | null>(null);
  const [mrn, setMrn] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [presetFailure, setPresetFailure] = useState(false);
  const key = useRef<{ sig: string; key: string } | null>(null);

  // A flag names the two records by ID; resolve them so the user sees names and MRNs before sending (UI-UX 8, Merge).
  useEffect(() => {
    if (preset === null) return;
    let live = true;
    void Promise.all([api.patient(preset.survivorId), api.patient(preset.mergedId)]).then(
      ([a, b]) => {
        if (!live) return;
        if (a.ok && b.ok) {
          setSurvivor(a.data);
          setMerged(b.data);
        } else setPresetFailure(true);
      },
    );
    return () => {
      live = false;
    };
  }, [api, preset]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: FieldError[] = [];
    if (survivor === null) errs.push({ fieldId: 'merge-survivor', message: p.survivorHint });
    if (merged === null) errs.push({ fieldId: 'merge-merged', message: p.mergedHint });
    if (survivor !== null && merged !== null && survivor.id === merged.id)
      errs.push({ fieldId: 'merge-merged', message: p.mergeSameRecord });
    if (survivor !== null && mrn.trim().toUpperCase() !== survivor.mrn.toUpperCase())
      errs.push({ fieldId: 'merge-mrn', message: p.mergeMrnWrong });
    if (reason.trim() === '' || reason.length > 500)
      errs.push({ fieldId: 'merge-reason', message: p.mergeReasonMissing });
    setErrors(errs);
    if (errs.length > 0 || survivor === null || merged === null) return;
    const sig = JSON.stringify([survivor.id, merged.id, reason]);
    if (key.current === null || key.current.sig !== sig) key.current = { sig, key: newKey() };
    setBusy(true);
    setFailure(null);
    const r = await api.requestMerge(
      { survivorId: survivor.id, mergedId: merged.id, reason: reason.trim() },
      key.current.key,
    );
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setSent(r.data.id);
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
    }
  }

  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  if (sent !== null)
    return (
      <Banner tone="info">
        <p>{p.mergeSent}</p>
        <TextField
          label={p.mergeRefSentLabel}
          readOnly
          value={sent}
          onFocus={(e) => e.currentTarget.select()}
        />
      </Banner>
    );

  return (
    <section aria-labelledby="mreq-title" className="ehr-card">
      <h3 id="mreq-title">{p.mergeRequestTitle}</h3>
      <p>{p.mergeBody}</p>
      {presetFailure && (
        <Banner tone="warning">
          <p>{p.loadFailed}</p>
        </Banner>
      )}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary errors={errors} />
        <fieldset>
          <legend>{p.survivor}</legend>
          <RecordLine r={survivor} label={p.survivor} />
          {survivor === null && (
            <PatientPicker
              idPrefix="ms"
              chooseLabel={p.chooseRecord}
              chosenId={null}
              onChoose={setSurvivor}
            />
          )}
          {err('merge-survivor') && <p role="alert">{err('merge-survivor')}</p>}
        </fieldset>
        <fieldset>
          <legend>{p.merged}</legend>
          <RecordLine r={merged} label={p.merged} />
          {merged === null && (
            <PatientPicker
              idPrefix="mm"
              chooseLabel={p.chooseRecord}
              chosenId={null}
              onChoose={setMerged}
            />
          )}
          {err('merge-merged') && <p role="alert">{err('merge-merged')}</p>}
        </fieldset>
        {survivor !== null && (
          <TextField
            id="merge-mrn"
            label={p.mergeMrnLabel}
            hint={p.mergeTypeMrn(survivor.mrn)}
            value={mrn}
            onChange={(e) => setMrn(e.target.value)}
            error={err('merge-mrn')}
            autoComplete="off"
          />
        )}
        <TextAreaField
          id="merge-reason"
          label={p.mergeReason}
          hint={p.mergeReasonHint}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={err('merge-reason')}
          rows={3}
        />
        <p className="ehr-muted">{p.mergeAudit}</p>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? p.mergeSending : p.mergeSend}
        </Button>
      </form>
      {failure !== null && <ActionError failure={failure} />}
    </section>
  );
}

const STATUS_TEXT: Record<MergeRequest['status'], string> = {
  requested: p.mergeStatusRequested,
  approved: p.mergeStatusApproved,
  rejected: p.mergeStatusRejected,
  executing: p.mergeStatusExecuting,
  completed: p.mergeStatusCompleted,
  failed: p.mergeStatusFailed,
  cancelled: p.mergeStatusCancelled,
};

/** The approval screen (UI-UX 7.3): a second person opens the request by its reference and approves or rejects it. */
export function MergeDecision() {
  const { api } = useDesk();
  const [ref, setRef] = useState('');
  const [refError, setRefError] = useState<string | undefined>();
  const [id, setId] = useState<string | null>(null);

  function open(e: React.FormEvent) {
    e.preventDefault();
    if (!UUID.test(ref.trim())) return setRefError(p.mergeRefInvalid);
    setRefError(undefined);
    setId(ref.trim().toLowerCase());
  }

  return (
    <section aria-labelledby="mdec-title" className="ehr-card">
      <h3 id="mdec-title">{p.mergeStatusTitle}</h3>
      <form onSubmit={open} noValidate>
        <TextField
          id="merge-ref"
          label={p.mergeRefLabel}
          hint={p.mergeRefHint}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          error={refError}
          autoComplete="off"
        />
        <Button type="submit">{p.mergeRefOpen}</Button>
      </form>
      {id !== null && <MergeDetail key={id} id={id} api={api} />}
    </section>
  );
}

function MergeDetail({ id, api }: { id: string; api: ReturnType<typeof useDesk>['api'] }) {
  const [version, setVersion] = useState(0);
  const { state, reload } = useLoad(() => api.merge(id), [id, version]);
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = useRef<{ decision: string; key: string } | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    if (key.current === null || key.current.decision !== decision)
      key.current = { decision, key: newKey() };
    setBusy(true);
    setFailure(null);
    const r = await api.decideMerge(id, decision, key.current.key);
    setBusy(false);
    setConfirm(null);
    if (r.ok) {
      key.current = null;
      setDone(p.mergeDecided(STATUS_TEXT[r.data.status]));
      setVersion((v) => v + 1);
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
    }
  }

  if (state.kind === 'loading') return <LoadingState label={p.mergeStatusTitle} lines={3} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
  const m = state.data;
  return (
    <div>
      <p>
        <strong>{p.mergeStatus}: </strong>
        <StatusChip
          tone={
            m.status === 'failed' || m.status === 'rejected'
              ? 'danger'
              : m.status === 'completed'
                ? 'success'
                : 'info'
          }
        >
          {STATUS_TEXT[m.status]}
        </StatusChip>
      </p>
      {m.survivorId === null || m.mergedId === null ? (
        <p className="ehr-muted">{p.mergeRecordsHidden}</p>
      ) : null}
      {m.reason !== null ? (
        <p>
          <strong>{p.mergeReasonShown}: </strong>
          {m.reason}
        </p>
      ) : (
        <p className="ehr-muted">{p.mergeReasonHidden}</p>
      )}
      {m.overlapsAfterMerge !== null && m.overlapsAfterMerge > 0 && (
        <p>{p.mergeOverlaps(m.overlapsAfterMerge)}</p>
      )}
      {done !== null && (
        <Banner tone="info">
          <p>{done}</p>
        </Banner>
      )}
      {failure !== null && <ActionError failure={failure} />}
      {m.status === 'requested' && m.callerIsRequester !== true && (
        <span className="ehr-actions">
          <Button variant="primary" disabled={busy} onClick={() => setConfirm('approve')}>
            {p.mergeApprove}
          </Button>
          <Button disabled={busy} onClick={() => setConfirm('reject')}>
            {p.mergeReject}
          </Button>
        </span>
      )}
      {confirm !== null && (
        <ConfirmRiskDialog
          title={confirm === 'approve' ? p.mergeApprove : p.mergeReject}
          consequence={confirm === 'approve' ? p.mergeApproveConfirm : p.mergeRejectConfirm}
          confirmLabel={confirm === 'approve' ? p.mergeApprove : p.mergeReject}
          cancelLabel={p.cancel}
          busy={busy}
          onConfirm={() => void decide(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
