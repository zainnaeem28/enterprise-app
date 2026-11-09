import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ConfirmRiskDialog,
  OfflineBanner,
  SignNoteDialog,
  TextAreaField,
  uiStrings,
} from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError } from './Problem.js';
import { ReauthRetryDialog } from './SignFlow.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import { timeOf } from './format.js';
import { noteStore } from './workspace.js';
import type { Addendum, Encounter, Note, Visit } from './types.js';

const SECTIONS = ['subjective', 'objective', 'assessment', 'plan'] as const;
const AUTOSAVE_MS = 3000;

export const isReauth = (f: Failure): boolean =>
  f.status === 401 && f.code === 'auth.reauth_required';

type Patient = { id: string; name: string; dob: string };

/**
 * DR-03 note editor with DR-05 sign dialog and DR-06 addenda. The draft is saved on the server before signing; a
 * `401 auth.reauth_required` keeps the dialog and the idempotency key, and repeats the same request after the second sign-in.
 */
export function NoteEditor({
  patient,
  visit,
  resume,
}: {
  patient: Patient | null;
  visit?: Visit;
  /** A note this session already holds (there is no route that reads a note back). */
  resume?: Note;
}) {
  const { api, can, online, openReauth } = useDoctor();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [note, setNote] = useState<Note | null>(resume ?? null);
  const [sections, setSections] = useState<Record<string, string>>(resume?.sections ?? {});
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'save' | 'sign' | 'addendum'>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [consentMissing, setConsentMissing] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionTried, setExceptionTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reauth, setReauth] = useState<{ opened: boolean } | null>(null);
  const [addenda, setAddenda] = useState<Addendum[]>([]);
  const [addendumText, setAddendumText] = useState('');
  const [addendumError, setAddendumError] = useState<string | undefined>();
  const startKey = useRef(newKey());
  const noteKey = useRef(newKey());
  const signKey = useRef<string | null>(null);
  const addKey = useRef<string | null>(null);

  const locked = note !== null && note.status !== 'draft';
  const canSign = can('clinical.note.sign');
  const canWrite = can('clinical.note.write');

  function adopt(n: Note) {
    setNote(n);
    if (patient !== null)
      noteStore.put({ note: n, patientName: patient.name, dateOfBirth: patient.dob });
  }

  async function makeNote(enc: Encounter): Promise<boolean> {
    const r = await api.createNote(enc.id, noteKey.current);
    if (!r.ok) {
      setFailure(r);
      return false;
    }
    noteKey.current = newKey();
    setSections(r.data.sections);
    adopt(r.data);
    return true;
  }

  /**
   * `POST /encounters` answers 409 when the visit already has its encounter (a consultation in progress). There is no read
   * route for an encounter by reservation, so the clinician's own draft for this patient is the way back in. False when none is found.
   */
  async function resumeDraft(): Promise<boolean> {
    if (visit === undefined) return false;
    const list = await api.myNotes(visit.clinicianId);
    if (!list.ok) return false;
    const drafts = list.data
      .filter((n) => n.status === 'draft' && n.patientId === visit.patientId)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    for (const d of drafts) {
      const got = await api.getNote(d.noteId);
      if (!got.ok) continue;
      setSections(got.data.sections);
      adopt(got.data);
      return true;
    }
    return false;
  }

  async function start(reason?: string) {
    if (visit === undefined) return;
    setBusy('start');
    setFailure(null);
    let enc = encounter;
    if (enc === null) {
      const r = await api.startEncounter(visit.reservationId, startKey.current, reason);
      if (!r.ok) {
        if (r.status === 409 && r.code !== 'clinical.consents_missing' && (await resumeDraft())) {
          setBusy(null);
          return;
        }
        setBusy(null);
        if (r.status === 409 && r.code === 'clinical.consents_missing') setConsentMissing(true);
        else setFailure(r);
        if (r.status !== 0 && r.status < 500) startKey.current = newKey();
        return;
      }
      startKey.current = newKey();
      enc = r.data;
      setEncounter(enc);
      setConsentMissing(false);
    }
    await makeNote(enc);
    setBusy(null);
  }

  async function startWithException() {
    if (exceptionReason.trim() === '') {
      setExceptionTried(true);
      return;
    }
    await start(exceptionReason.trim());
  }

  async function save(): Promise<boolean> {
    if (note === null || locked) return true;
    setBusy('save');
    setFailure(null);
    const r = await api.saveNote(note.id, note.version, sections);
    setBusy(null);
    if (!r.ok) {
      setFailure(r);
      return false;
    }
    adopt(r.data);
    setDirty(false);
    setSavedAt(new Date().toISOString());
    return true;
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || locked || !online || busy !== null) return;
    const t = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, sections, locked, online, busy]);

  async function requestSign() {
    if (note === null) return;
    if (dirty && !(await save())) return;
    signKey.current = newKey();
    setConfirming(true);
  }

  async function confirmSign() {
    if (note === null || signKey.current === null) return;
    setBusy('sign');
    setFailure(null);
    const r = await api.signNote(note.id, note.version, signKey.current);
    setBusy(null);
    if (r.ok) {
      signKey.current = null;
      setConfirming(false);
      setReauth(null);
      adopt(r.data);
      return;
    }
    if (isReauth(r)) {
      setReauth((s) => s ?? { opened: false });
      return;
    }
    signKey.current = null;
    setConfirming(false);
    setReauth(null);
    setFailure(r);
  }

  async function addAddendum() {
    if (note === null) return;
    if (addendumText.trim() === '') return setAddendumError(d.addendumNeeded);
    setAddendumError(undefined);
    setBusy('addendum');
    setFailure(null);
    addKey.current ??= newKey();
    const r = await api.addAddendum(note.id, addendumText.trim(), addKey.current);
    setBusy(null);
    if (r.ok) {
      addKey.current = null;
      setAddenda((a) => [...a, r.data]);
      noteStore.addAddendum(note.id, r.data);
      setAddendumText('');
    } else {
      if (r.status !== 0 && r.status < 500) addKey.current = null;
      setFailure(r);
    }
  }

  const header = <h2 id="note-title">{d.noteTitle}</h2>;

  if (note === null) {
    return (
      <section aria-labelledby="note-title" className="ehr-card">
        {header}
        {!online && <OfflineBanner />}
        {visit === undefined ? (
          <p className="ehr-muted">{d.noVisitSelected}</p>
        ) : !can('clinical.consultation.start') ? (
          <p className="ehr-muted">{d.noStartPermission}</p>
        ) : (
          <>
            {failure !== null && <ActionError failure={failure} />}
            {consentMissing && (
              <Banner tone="warning" title={d.consentsMissing}>
                <p>{d.consentsMissingHelp}</p>
              </Banner>
            )}
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={busy !== null || !online || patient === null || consentMissing}
            >
              {busy === 'start' ? d.starting : d.startConsultation}
            </Button>
            {consentMissing && (
              <div className="ehr-doc-exception">
                <TextAreaField
                  label={d.emergencyReason}
                  value={exceptionReason}
                  onChange={(e) => setExceptionReason(e.target.value)}
                  error={
                    exceptionTried && exceptionReason.trim() === ''
                      ? d.emergencyReasonNeeded
                      : undefined
                  }
                />
                <Button
                  onClick={() => void startWithException()}
                  disabled={busy !== null || !online}
                >
                  {d.emergencyStart}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  const keys = SECTIONS.filter((k) => k in note.sections || k in sections);
  const status =
    note.status === 'signed'
      ? d.signed
      : note.status === 'pending_cosign'
        ? d.pendingCosign
        : busy === 'save'
          ? d.noteSaving
          : savedAt !== null
            ? uiStrings.draftSaved(timeOf(savedAt))
            : d.draftNotSaved;

  return (
    <section aria-labelledby="note-title" className="ehr-card">
      {header}
      {!online && <OfflineBanner />}
      <p role="status" className="ehr-soap__status">
        {status}
      </p>
      {failure !== null && <ActionError failure={failure} />}
      <form className="ehr-soap" aria-label={d.noteTitle} onSubmit={(e) => e.preventDefault()}>
        {(keys.length > 0 ? keys : SECTIONS).map((k) => (
          <TextAreaField
            key={k}
            label={d.sectionLabel(k)}
            value={sections[k] ?? ''}
            readOnly={locked}
            onChange={(e) => {
              setSections({ ...sections, [k]: e.target.value });
              setDirty(true);
            }}
          />
        ))}
        {!locked && canWrite && (
          <div className="ehr-dialog__actions">
            <Button onClick={() => void save()} disabled={busy !== null || !online}>
              {uiStrings.saveDraft}
            </Button>
            <Button
              variant="primary"
              onClick={() => void requestSign()}
              disabled={busy !== null || !online || patient === null}
            >
              {canSign ? uiStrings.signAndLock : d.submitForCosign}
            </Button>
          </div>
        )}
      </form>

      {confirming &&
        patient !== null &&
        reauth === null &&
        (canSign ? (
          <SignNoteDialog
            patient={{ name: patient.name, dob: patient.dob }}
            busy={busy === 'sign'}
            onConfirm={() => void confirmSign()}
            onCancel={() => {
              setConfirming(false);
              signKey.current = null;
            }}
          />
        ) : (
          <ConfirmRiskDialog
            title={d.submitForCosign}
            consequence={d.submitConsequence}
            confirmLabel={d.submitForCosign}
            patient={{ name: patient.name, dob: patient.dob }}
            busy={busy === 'sign'}
            onConfirm={() => void confirmSign()}
            onCancel={() => {
              setConfirming(false);
              signKey.current = null;
            }}
          />
        ))}
      {reauth !== null && (
        <ReauthRetryDialog
          opened={reauth.opened}
          retryLabel={canSign ? d.reauthRetry : d.reauthRetrySubmit}
          onOpen={() => {
            openReauth();
            setReauth({ opened: true });
          }}
          onRetry={() => void confirmSign()}
          onCancel={() => {
            setReauth(null);
            setConfirming(false);
            signKey.current = null;
          }}
        />
      )}

      {note.status !== 'draft' && (
        <section aria-labelledby="addenda-title" className="ehr-doc-addenda">
          <h3 id="addenda-title" className="ehr-state__sub">
            {d.addendumTitle}
          </h3>
          {addenda.length === 0 ? (
            <p className="ehr-muted">{d.addendumNone}</p>
          ) : (
            <ul className="ehr-plain-list">
              {addenda.map((a) => (
                <li key={a.id}>
                  <p>{a.body}</p>
                  <p className="ehr-muted">{d.addendumBy(timeOf(a.signedAt))}</p>
                </li>
              ))}
            </ul>
          )}
          {note.status === 'signed' && canWrite && (
            <>
              <p className="ehr-muted">{d.addendumHint}</p>
              <TextAreaField
                label={d.addendumLabel}
                value={addendumText}
                error={addendumError}
                onChange={(e) => setAddendumText(e.target.value)}
              />
              <Button onClick={() => void addAddendum()} disabled={busy !== null || !online}>
                {d.addendumSave}
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
