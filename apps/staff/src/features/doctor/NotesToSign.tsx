import { useRef, useState } from 'react';
import { Banner, Button, ConfirmRiskDialog, EmptyState, StatusChip, Tabs } from '@ehr/ui';
import type { TabItem } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError } from './Problem.js';
import { ReauthRetryDialog } from './SignFlow.js';
import { isReauth } from './NoteEditor.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import { noteStore, useKnownNotes, workspace } from './workspace.js';
import type { KnownNote } from './workspace.js';

function Sections({ note }: { note: KnownNote['note'] }) {
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
  known: KnownNote;
  done: boolean;
  onDone: (id: string) => void;
}) {
  const { api, openReauth, online } = useDoctor();
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reauth, setReauth] = useState<{ opened: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const key = useRef<string | null>(null);

  async function cosign() {
    key.current ??= newKey();
    setBusy(true);
    setFailure(null);
    const r = await api.cosignNote(known.note.id, key.current);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setConfirming(false);
      setReauth(null);
      onDone(known.note.id);
      noteStore.put({
        note: r.data,
        patientName: known.patientName,
        dateOfBirth: known.dateOfBirth,
      });
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
      {reviewing && <Sections note={known.note} />}
      <div className="ehr-actions">
        <Button onClick={() => setReviewing((v) => !v)} aria-expanded={reviewing}>
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

/** DR-07: drafts to sign and the co-sign queue. Both show the notes this session has opened (no route lists them, see README). */
export function NotesToSign() {
  const { can, navigate } = useDoctor();
  const known = useKnownNotes();
  const [tab, setTab] = useState('sign');
  const drafts = known.filter((k) => k.note.status === 'draft');
  const [cosigned, setCosigned] = useState<string[]>([]);
  const pending = known.filter(
    (k) => k.note.status === 'pending_cosign' || cosigned.includes(k.note.id),
  );

  const items: TabItem[] = [
    {
      id: 'sign',
      label: d.tabToSign,
      count: drafts.length,
      panel:
        drafts.length === 0 ? (
          <EmptyState message={d.toSignEmpty} />
        ) : (
          <ul className="ehr-plain-list">
            {drafts.map((k) => (
              <li key={k.note.id} className="ehr-card">
                <p>
                  <strong>{k.patientName}</strong>, {k.dateOfBirth}{' '}
                  <StatusChip tone="neutral">{d.statusDraft}</StatusChip>
                </p>
                <Button
                  onClick={() => {
                    workspace.set({ patientId: k.note.patientId, label: k.patientName });
                    navigate('/patients');
                  }}
                >
                  {d.open}
                  <span className="ehr-visually-hidden"> {k.patientName}</span>
                </Button>
              </li>
            ))}
          </ul>
        ),
    },
  ];
  if (can('clinical.note.cosign'))
    items.push({
      id: 'cosign',
      label: d.tabCosign,
      count: pending.length,
      panel:
        pending.length === 0 ? (
          <EmptyState message={d.cosignEmpty} />
        ) : (
          <ul className="ehr-plain-list">
            {pending.map((k) => (
              <CosignRow
                key={k.note.id}
                known={k}
                done={cosigned.includes(k.note.id)}
                onDone={(id) => setCosigned((c) => [...c, id])}
              />
            ))}
          </ul>
        ),
    });
  const selected = items.some((i) => i.id === tab) ? tab : 'sign';

  return (
    <section aria-labelledby="notes-title">
      <h1 id="notes-title">{d.notesTitle}</h1>
      <Banner tone="info">
        <p>{d.listGap}</p>
      </Banner>
      <Tabs items={items} selected={selected} onSelect={setTab} label={d.notesTitle} />
    </section>
  );
}
