import { useRef, useState } from 'react';
import {
  Banner,
  Button,
  ConfirmRiskDialog,
  EmptyState,
  LoadingState,
  PermissionNote,
  StatusChip,
  Tabs,
} from '@ehr/ui';
import type { TabItem } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import { ReauthRetryDialog } from './SignFlow.js';
import { isReauth } from './NoteEditor.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import { noteStore, workspace } from './workspace.js';
import type { Note, NoteListItem } from './types.js';

function Sections({ note }: { note: Note }) {
  return (
    <dl className="ehr-dl">
      {Object.entries(note.sections).map(([k, v]) => (
        <div key={k}>
          <dt>{d.sectionLabel(k)}</dt>
          <dd className="ehr-doc-pre">{v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CosignRow({
  known,
  done,
  onDone,
}: {
  known: NoteListItem;
  done: boolean;
  onDone: (id: string) => void;
}) {
  const { api, openReauth, online } = useDoctor();
  const [reviewing, setReviewing] = useState(false);
  const [loaded, setLoaded] = useState<Note | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reauth, setReauth] = useState<{ opened: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const key = useRef<string | null>(null);

  async function cosign() {
    key.current ??= newKey();
    setBusy(true);
    setFailure(null);
    const r = await api.cosignNote(known.noteId, key.current);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setConfirming(false);
      setReauth(null);
      onDone(known.noteId);
      return;
    }
    if (isReauth(r)) {
      setReauth((s) => s ?? { opened: false });
      return;
    }
    key.current = null;
    setConfirming(false);
    setReauth(null);
    setFailure(r);
  }

  async function toggleReview() {
    if (reviewing) return setReviewing(false);
    setReviewing(true);
    if (loaded !== null) return;
    setFailure(null);
    const r = await api.getNote(known.noteId);
    if (r.ok) setLoaded(r.data);
    else {
      setReviewing(false);
      setFailure(r);
    }
  }

  return (
    <li className="ehr-card">
      <p>
        <strong>{known.patientName}</strong>, {known.dateOfBirth}{' '}
        <StatusChip tone={done ? 'neutral' : 'warning'}>
          {done ? d.statusSigned : d.statusPending}
        </StatusChip>
      </p>
      {failure !== null && <ActionError failure={failure} />}
      {done && (
        <Banner tone="info">
          <p>{d.cosignDone}</p>
        </Banner>
      )}
      {reviewing &&
        (loaded === null ? (
          <LoadingState label={d.review} lines={3} />
        ) : (
          <Sections note={loaded} />
        ))}
      <div className="ehr-actions">
        <Button onClick={() => void toggleReview()} aria-expanded={reviewing}>
          {d.review}
          <span className="ehr-visually-hidden"> {known.patientName}</span>
        </Button>
        {!done && (
          <Button
            variant="primary"
            disabled={busy || !online}
            onClick={() => {
              key.current = newKey();
              setConfirming(true);
            }}
          >
            {d.cosignAction}
            <span className="ehr-visually-hidden"> {known.patientName}</span>
          </Button>
        )}
      </div>
      {confirming && reauth === null && (
        <ConfirmRiskDialog
          title={d.cosignTitle}
          consequence={d.cosignConsequence}
          confirmLabel={d.cosignAction}
          patient={{ name: known.patientName, dob: known.dateOfBirth }}
          busy={busy}
          onConfirm={() => void cosign()}
          onCancel={() => {
            setConfirming(false);
            key.current = null;
          }}
        />
      )}
      {reauth !== null && (
        <ReauthRetryDialog
          opened={reauth.opened}
          retryLabel={d.reauthCosignRetry}
          onOpen={() => {
            openReauth();
            setReauth({ opened: true });
          }}
          onRetry={() => void cosign()}
          onCancel={() => {
            setReauth(null);
            setConfirming(false);
            key.current = null;
          }}
        />
      )}
    </li>
  );
}

function DraftRow({ item }: { item: NoteListItem }) {
  const { api, navigate } = useDoctor();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  /** Reads the note first, so the editor resumes the saved sections and version after a reload. */
  async function open() {
    setBusy(true);
    setFailure(null);
    const r = await api.getNote(item.noteId);
    setBusy(false);
    if (!r.ok) return setFailure(r);
    noteStore.put({ note: r.data, patientName: item.patientName, dateOfBirth: item.dateOfBirth });
    workspace.set({ patientId: item.patientId, label: item.patientName });
    navigate('/patients');
  }

  return (
    <li className="ehr-card">
      <p>
        <strong>{item.patientName}</strong>, {item.dateOfBirth}{' '}
        <StatusChip tone="neutral">
          {item.status === 'draft' ? d.statusDraft : d.statusPending}
        </StatusChip>
      </p>
      {failure !== null && <ActionError failure={failure} />}
      <Button disabled={busy} onClick={() => void open()}>
        {d.open}
        <span className="ehr-visually-hidden"> {item.patientName}</span>
      </Button>
    </li>
  );
}

/** DR-07: own drafts to sign (`GET /clinicians/{id}/notes`) and the co-sign queue (`GET /clinicians/{id}/cosign-queue`). */
export function NotesToSign() {
  const { api, can, principalId } = useDoctor();
  const [tab, setTab] = useState('sign');
  const [cosigned, setCosigned] = useState<string[]>([]);
  const canWrite = can('clinical.note.write');
  const canCosign = can('clinical.note.cosign');
  const mine = useLoad(() => api.myNotes(principalId), [principalId], canWrite);
  const queue = useLoad(() => api.cosignQueue(principalId), [principalId], canCosign);

  const panel = (
    load: typeof mine,
    empty: string,
    render: (items: NoteListItem[]) => React.ReactNode,
    label: string,
  ) =>
    load.state.kind === 'loading' ? (
      <LoadingState label={label} lines={3} />
    ) : load.state.kind === 'error' ? (
      <LoadError failure={load.state.failure} onRetry={load.reload} />
    ) : load.state.data.length === 0 ? (
      <EmptyState message={empty} />
    ) : (
      <ul className="ehr-plain-list">{render(load.state.data)}</ul>
    );

  const count = (load: typeof mine) => (load.state.kind === 'ready' ? load.state.data.length : 0);
  const items: TabItem[] = [];
  if (canWrite)
    items.push({
      id: 'sign',
      label: d.tabToSign,
      count: count(mine),
      panel: panel(
        mine,
        d.toSignEmpty,
        (list) => list.map((k) => <DraftRow key={k.noteId} item={k} />),
        d.tabToSign,
      ),
    });
  if (canCosign)
    items.push({
      id: 'cosign',
      label: d.tabCosign,
      count: count(queue),
      panel: panel(
        queue,
        d.cosignEmpty,
        (list) =>
          list.map((k) => (
            <CosignRow
              key={k.noteId}
              known={k}
              done={cosigned.includes(k.noteId)}
              onDone={(id) => setCosigned((c) => [...c, id])}
            />
          )),
        d.tabCosign,
      ),
    });
  const selected = items.some((i) => i.id === tab) ? tab : (items[0]?.id ?? '');

  return (
    <section aria-labelledby="notes-title">
      <h1 id="notes-title">{d.notesTitle}</h1>
      {items.length === 0 ? (
        <PermissionNote scope={d.notesNoRead} />
      ) : (
        <Tabs items={items} selected={selected} onSelect={setTab} label={d.notesTitle} />
      )}
    </section>
  );
}
