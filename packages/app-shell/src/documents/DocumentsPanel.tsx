import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button, EmptyState, LoadingState, SelectField, StatusChip } from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { documentStrings } from './strings.js';
import type { DocumentStrings } from './strings.js';
import type { DocumentsApi, Failure } from './api.js';
import { newTransfer, runTransfer, xhrPutObject } from './transfer.js';
import type { PutObject, Transfer } from './transfer.js';
import { CLASSIFICATIONS, PATIENT_UPLOAD_CLASSIFICATIONS, isOpenable, isPending } from './types.js';
import type { Classification, DocumentRecord, DocumentStatus } from './types.js';

export interface DocumentPermissions {
  read: boolean;
  upload: boolean;
  /** `documents.classify`: staff classify and confirm. Server authorization stays authoritative. */
  classify: boolean;
}

export interface DocumentsPanelProps {
  api: DocumentsApi;
  patientId: string;
  permissions: DocumentPermissions;
  /** Classes the uploader may name. Patients: four of the eight; staff: all. */
  uploadClassifications?: readonly Classification[];
  putObject?: PutObject;
  /** Opens a short-lived download URL; return false if the browser blocked it. */
  openUrl?: (url: string) => boolean;
  /** Poll interval while a file is uploading or scanning. */
  pollMs?: number;
  strings?: DocumentStrings;
}

const TONE: Record<DocumentStatus, Tone> = {
  awaiting_upload: 'warning',
  scanning: 'info',
  quarantined: 'danger',
  clean: 'warning',
  confirmed: 'success',
  deleted: 'neutral',
};

const defaultOpen = (url: string): boolean =>
  window.open(url, '_blank', 'noopener,noreferrer') !== null;

export function errorText(f: Failure, s: DocumentStrings): string {
  const e = s.errors;
  const suffix = f.requestId !== undefined ? ` (reference ${f.requestId})` : '';
  switch (f.code) {
    case 'documents.type_not_allowed':
      return e.typeNotAllowed;
    case 'documents.too_large':
      return e.tooLarge;
    case 'documents.not_available':
      return e.notAvailable;
    case 'auth.forbidden':
      return e.forbidden;
    case 'kernel.rate_limited':
      return e.rateLimited;
    default:
  }
  if (f.status === 428) return e.versionUnknown;
  if (f.status === 412 || f.status === 409) return e.stale;
  if (f.status === 0) return e.network;
  return e.generic + suffix;
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const sizeText = (n: number | null): string =>
  n === null
    ? ''
    : n < 1024 * 1024
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** SH-01 upload with progress and scan state; SH-02 list and viewer; staff classification confirm (J-19). */
export function DocumentsPanel({
  api,
  patientId,
  permissions,
  uploadClassifications,
  putObject = xhrPutObject,
  openUrl = defaultOpen,
  pollMs = 3000,
  strings = documentStrings,
}: DocumentsPanelProps) {
  const s = strings;
  const classes =
    uploadClassifications ??
    (permissions.classify ? CLASSIFICATIONS : PATIENT_UPLOAD_CLASSIFICATIONS);
  const [docs, setDocs] = useState<DocumentRecord[] | undefined>();
  const [loadFailure, setLoadFailure] = useState<Failure | undefined>();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [chosen, setChosen] = useState<Classification | ''>('');
  const fileId = useId();
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await api.list(patientId);
    if (!alive.current) return;
    if (r.ok) {
      setDocs(r.data);
      setLoadFailure(undefined);
    } else setLoadFailure(r);
  }, [api, patientId]);

  useEffect(() => {
    if (permissions.read) void load();
  }, [load, permissions.read]);

  const pending = docs?.some((d) => isPending(d.status)) === true;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [pending, load, pollMs]);

  const patch = useCallback((t: Transfer) => {
    if (alive.current) setTransfers((all) => all.map((x) => (x.id === t.id ? t : x)));
  }, []);

  const start = useCallback(
    async (t: Transfer) => {
      const final = await runTransfer(api, putObject, patientId, t, patch);
      if (final.state === 'done') {
        if (alive.current) setTransfers((all) => all.filter((x) => x.id !== final.id));
        await load();
      }
    },
    [api, putObject, patientId, patch, load],
  );

  const onPick = (files: FileList | null) => {
    if (files === null) return;
    const fresh = Array.from(files).map((f) => newTransfer(f, chosen === '' ? undefined : chosen));
    setTransfers((all) => [...all, ...fresh]);
    for (const t of fresh) void start(t);
    if (input.current !== null) input.current.value = '';
  };

  return (
    <section aria-labelledby={`${fileId}-h`} className="ehr-stack">
      <h2 id={`${fileId}-h`}>{s.heading}</h2>

      {permissions.upload ? (
        <div className="ehr-card">
          <h3>{s.uploadHeading}</h3>
          <SelectField
            label={s.classLabel}
            value={chosen}
            onChange={(e) => setChosen(e.target.value as Classification | '')}
          >
            <option value="">{s.classUnset}</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {s.classLabels[c]}
              </option>
            ))}
          </SelectField>
          <label htmlFor={fileId} className="ehr-field__label">
            {s.chooseFile}
          </label>
          <input
            ref={input}
            id={fileId}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png"
            className="ehr-input"
            aria-describedby={`${fileId}-hint`}
            onChange={(e) => onPick(e.target.files)}
          />
          <p id={`${fileId}-hint`} className="ehr-muted">
            {s.chooseHint}
          </p>
          {transfers.length > 0 && (
            <ul className="ehr-plain-list" aria-label={s.transfersLabel}>
              {transfers.map((t) => (
                <TransferRow
                  key={t.id}
                  t={t}
                  s={s}
                  onRetry={() => void start(t)}
                  onDismiss={() => setTransfers((all) => all.filter((x) => x.id !== t.id))}
                />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="ehr-permission-note">{s.noUploadPermission}</p>
      )}

      {!permissions.read ? (
        <p className="ehr-permission-note">{s.noReadPermission}</p>
      ) : docs === undefined && loadFailure === undefined ? (
        <LoadingState label={s.heading} />
      ) : loadFailure !== undefined ? (
        <Banner tone="danger" actions={<Button onClick={() => void load()}>{s.refresh}</Button>}>
          {s.loadFailed} {errorText(loadFailure, s)}
        </Banner>
      ) : docs !== undefined && docs.length === 0 ? (
        <EmptyState message={s.empty} />
      ) : (
        <ul className="ehr-plain-list" aria-label={s.listLabel}>
          {docs?.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              api={api}
              s={s}
              canClassify={permissions.classify}
              openUrl={openUrl}
              onChanged={(next) => setDocs((all) => all?.map((x) => (x.id === next.id ? next : x)))}
              onStale={() => void load()}
            />
          ))}
        </ul>
      )}
      {pending && <p className="ehr-muted">{s.scanPending}</p>}
    </section>
  );
}

function TransferRow({
  t,
  s,
  onRetry,
  onDismiss,
}: {
  t: Transfer;
  s: DocumentStrings;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const pct = Math.round(t.fraction * 100);
  const failed = t.state === 'failed';
  return (
    <li className="ehr-card">
      <strong>{t.name}</strong>{' '}
      {failed ? (
        <>
          <StatusChip tone="danger">
            {t.failure ? errorText(t.failure as Failure, s) : s.errors.generic}
          </StatusChip>{' '}
          {t.failure?.code !== 'documents.type_not_allowed' &&
            t.failure?.code !== 'documents.too_large' && (
              <Button onClick={onRetry}>
                {s.retry}
                <span className="ehr-visually-hidden"> {t.name}</span>
              </Button>
            )}{' '}
          <Button onClick={onDismiss}>
            {s.dismiss}
            <span className="ehr-visually-hidden"> {t.name}</span>
          </Button>
        </>
      ) : (
        <>
          <StatusChip tone="info">
            {t.step === 'complete' ? s.finishing : s.uploading(pct)}
          </StatusChip>
          <progress
            max={100}
            value={t.step === 'create' ? undefined : pct}
            aria-label={`${t.name}: ${t.step === 'complete' ? s.finishing : s.uploading(pct)}`}
          />
        </>
      )}
    </li>
  );
}

function DocumentRow({
  doc,
  api,
  s,
  canClassify,
  openUrl,
  onChanged,
  onStale,
}: {
  doc: DocumentRecord;
  api: DocumentsApi;
  s: DocumentStrings;
  canClassify: boolean;
  openUrl: (url: string) => boolean;
  onChanged: (d: DocumentRecord) => void;
  onStale: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [link, setLink] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [choice, setChoice] = useState<Classification>(
    doc.suggestedClassification ?? doc.classification,
  );
  const [confirming, setConfirming] = useState(false);
  const label = s.classLabels[doc.classification];
  const meta = [when(doc.uploadedAt), sizeText(doc.sizeBytes)].filter(Boolean).join(' · ');

  const open = async () => {
    setOpening(true);
    setError(undefined);
    setLink(undefined);
    const r = await api.downloadUrl(doc.id);
    setOpening(false);
    if (!r.ok) return setError(errorText(r, s));
    if (!openUrl(r.data.url)) setLink(r.data.url);
  };

  const confirm = async () => {
    setConfirming(true);
    setError(undefined);
    let current = doc;
    if (choice !== doc.classification) {
      const c = await api.classify(doc.id, doc.version, choice);
      if (!c.ok) {
        setConfirming(false);
        setError(errorText(c, s));
        if (c.status === 412 || c.status === 409) onStale();
        return;
      }
      current = c.data;
    }
    const r = await api.confirm(doc.id, current.version);
    setConfirming(false);
    if (!r.ok) {
      setError(errorText(r, s));
      if (r.status === 412 || r.status === 409) onStale();
      else onChanged(current);
      return;
    }
    onChanged(r.data);
  };

  let body: ReactNode;
  if (doc.status === 'quarantined') {
    body = <p>{s.quarantineReason}</p>;
  } else if (isOpenable(doc.status)) {
    body = (
      <Button onClick={() => void open()} disabled={opening}>
        {opening ? s.opening : s.open}
        <span className="ehr-visually-hidden"> {label}</span>
      </Button>
    );
  } else {
    body = <p className="ehr-muted">{s.notOpenable}</p>;
  }

  return (
    <li className="ehr-card">
      <strong>{label}</strong> <span className="ehr-muted">{meta}</span>{' '}
      <StatusChip tone={TONE[doc.status]}>{s.statusLabel[doc.status]}</StatusChip>
      {doc.status === 'clean' && canClassify && (
        <>
          {' '}
          <StatusChip tone="warning">{s.needsConfirm}</StatusChip>
        </>
      )}
      {doc.onLegalHold && (
        <>
          {' '}
          <StatusChip tone="neutral">{s.heldNote}</StatusChip>
        </>
      )}
      {doc.status === 'confirmed' && doc.confirmedAt !== null && (
        <p className="ehr-muted">{s.confirmedAt(when(doc.confirmedAt))}</p>
      )}
      {body}
      {link !== undefined && (
        <p>
          <a href={link} target="_blank" rel="noopener noreferrer">
            {s.openLinkFallback}
          </a>
        </p>
      )}
      {doc.status === 'clean' && canClassify && (
        <div role="group" aria-label={`${s.confirmHeading}: ${label}`}>
          <SelectField
            label={s.classRowLabel}
            hint={
              doc.suggestedClassification !== null
                ? s.suggested(s.classLabels[doc.suggestedClassification])
                : s.confirmHint
            }
            value={choice}
            onChange={(e) => setChoice(e.target.value as Classification)}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {s.classLabels[c]}
              </option>
            ))}
          </SelectField>
          <Button variant="primary" onClick={() => void confirm()} disabled={confirming}>
            {confirming ? s.confirming : s.confirm}
            <span className="ehr-visually-hidden"> {label}</span>
          </Button>
        </div>
      )}
      {error !== undefined && <Banner tone="danger">{error}</Banner>}
    </li>
  );
}
