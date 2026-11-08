import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Banner, Button, ErrorSummary, LoadingState, StatusChip, TextField } from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { newTransfer, runTransfer, xhrPutObject, ALLOWED_CONTENT_TYPES } from '../documents.js';
import type { DocumentRecord, DocumentStatus, PutObject, Transfer } from '../documents.js';
import { newKey } from '../../profile/lib/core.js';
import type { Failure } from '../../profile/lib/core.js';
import { useSubmit } from '../../profile/lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../../profile/lib/hooks.js';
import { Problem } from '../../profile/lib/Problem.js';
import { usePrevisit } from '../ctx.js';
import { previsitPath } from '../routes.js';
import type { Coverage } from '../types.js';

export type Side = 'front' | 'back';

const SCAN: Record<DocumentStatus, { tone: Tone; text: string }> = {
  awaiting_upload: { tone: 'info', text: 'Uploading' },
  scanning: { tone: 'info', text: 'Checking the file for safety' },
  quarantined: { tone: 'danger', text: 'Needs fixing: the file was not accepted' },
  clean: { tone: 'success', text: 'Checked and ready' },
  confirmed: { tone: 'success', text: 'Checked and ready' },
  deleted: { tone: 'neutral', text: 'Removed' },
};

const POLL_MS = 3000;

/** PP-27 insurance card upload: front and back, with the scan state of each file (SH-01 pattern), then the card details. */
export function InsurancePage({
  putObject = xhrPutObject,
  pollMs = POLL_MS,
}: {
  putObject?: PutObject;
  pollMs?: number;
}) {
  const { api, patientId, reservationId, go, reload } = usePrevisit();
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Insurance card');
  const [coverage, setCoverage] = useState<Coverage | null | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [slots, setSlots] = useState<Partial<Record<Side, Transfer>>>({});
  const [ids, setIds] = useState<Partial<Record<Side, string>>>({});
  const [payer, setPayer] = useState('');
  const [member, setMember] = useState('');
  const [group, setGroup] = useState('');
  const [errors, setErrors] = useState<{ fieldId: string; message: string }[]>([]);
  const [problem, setProblem] = useState<Failure | undefined>();
  const [saved, setSaved] = useState(false);
  const addKey = useRef(newKey());
  const alive = useRef(true);
  const { busy, run } = useSubmit();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void api.coverages(patientId).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailure(r);
      const active = r.data.find((c) => c.active) ?? null;
      setCoverage(active);
      if (active !== null) {
        setPayer(active.payerName);
        setMember(active.memberId);
        setGroup(active.groupNumber);
        setIds({
          ...(active.frontDocumentId === null ? {} : { front: active.frontDocumentId }),
          ...(active.backDocumentId === null ? {} : { back: active.backDocumentId }),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [api, patientId]);

  const refreshDocs = useCallback(async () => {
    const r = await api.documents.list(patientId);
    if (r.ok && alive.current) setDocs(r.data);
  }, [api, patientId]);
  useEffect(() => {
    void refreshDocs();
  }, [refreshDocs]);

  const docOf = (side: Side): DocumentRecord | undefined => docs.find((d) => d.id === ids[side]);
  const pending = (['front', 'back'] as const).some((s) => {
    const d = docOf(s);
    return d !== undefined && (d.status === 'awaiting_upload' || d.status === 'scanning');
  });
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refreshDocs(), pollMs);
    return () => clearInterval(t);
  }, [pending, pollMs, refreshDocs]);

  const choose = (side: Side) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file === undefined) return;
    setSaved(false);
    void runTransfer(
      api.documents,
      putObject,
      patientId,
      newTransfer(file, 'insurance_card'),
      (t) => {
        if (alive.current) setSlots((s) => ({ ...s, [side]: t }));
        if (t.ticket !== undefined && alive.current)
          setIds((i) => ({ ...i, [side]: t.ticket?.documentId }));
      },
    ).then(() => refreshDocs());
  };

  const retry = (side: Side) => {
    const t = slots[side];
    if (t === undefined) return;
    void runTransfer(api.documents, putObject, patientId, t, (n) => {
      if (alive.current) setSlots((s) => ({ ...s, [side]: n }));
    }).then(() => refreshDocs());
  };

  if (failure !== undefined) return <Problem failure={failure} />;
  if (coverage === undefined) return <LoadingState label="Loading" lines={4} />;

  const bad = (side: Side) => docOf(side)?.status === 'quarantined';

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next: { fieldId: string; message: string }[] = [];
    if (payer.trim() === '')
      next.push({ fieldId: 'ins-payer', message: 'Enter the name of your insurance company' });
    if (member.trim() === '') next.push({ fieldId: 'ins-member', message: 'Enter your member ID' });
    if (bad('front') || bad('back'))
      next.push({
        fieldId: 'ins-front',
        message: 'Upload a new photo for the file that was not accepted',
      });
    setErrors(next);
    if (next.length > 0) return;
    void run(async () => {
      setProblem(undefined);
      const body: Record<string, unknown> = {
        payerName: payer.trim(),
        memberId: member.trim(),
        ...(group.trim() === '' ? {} : { groupNumber: group.trim() }),
        ...(ids.front === undefined ? {} : { frontDocumentId: ids.front }),
        ...(ids.back === undefined ? {} : { backDocumentId: ids.back }),
      };
      const r =
        coverage === null
          ? await api.addCoverage(patientId, body, addKey.current)
          : await api.saveCoverage(patientId, coverage.id, coverage.version, body);
      if (!r.ok) {
        if (r.status === 412)
          setCoverage(null === coverage ? null : { ...coverage, version: coverage.version + 1 });
        return setProblem(r);
      }
      setCoverage(r.data);
      setSaved(true);
      reload();
    });
  };

  const slot = (side: Side, label: string) => {
    const t = slots[side];
    const d = docOf(side);
    const state = t?.state === 'failed' ? undefined : d === undefined ? undefined : SCAN[d.status];
    return (
      <li className="pv-item" key={side}>
        <h2>{label}</h2>
        {t?.state === 'running' && <p role="status">Uploading {Math.round(t.fraction * 100)}%</p>}
        {t?.state === 'failed' && (
          <div role="alert">
            <p>
              {t.failure?.code === 'documents.type_not_allowed'
                ? 'This file type is not accepted. Use a PDF, JPEG or PNG.'
                : t.failure?.code === 'documents.too_large'
                  ? 'This file is too large.'
                  : 'The upload did not finish.'}
            </p>
            {t.failure?.code !== 'documents.type_not_allowed' &&
              t.failure?.code !== 'documents.too_large' && (
                <Button onClick={() => retry(side)}>Try again</Button>
              )}
          </div>
        )}
        {state !== undefined && <StatusChip tone={state.tone}>{state.text}</StatusChip>}
        {d === undefined && t === undefined && <StatusChip tone="warning">To do</StatusChip>}
        <label className="ehr-field__label" htmlFor={`ins-${side}`}>
          {d === undefined ? `Choose a photo or PDF of the ${side}` : `Replace the ${side}`}
        </label>
        <input
          id={`ins-${side}`}
          type="file"
          accept={ALLOWED_CONTENT_TYPES.join(',')}
          onChange={choose(side)}
          aria-describedby={`ins-${side}-hint`}
        />
        <p id={`ins-${side}-hint`} className="ehr-field__hint">
          PDF, JPEG or PNG.
        </p>
      </li>
    );
  };

  return (
    <section className="pv" aria-labelledby="i-h">
      <h1 id="i-h" ref={ref} tabIndex={-1}>
        Insurance card
      </h1>
      <p>Add photos of both sides of your card and the details printed on it.</p>
      <ErrorSummary errors={errors} />
      {problem !== undefined && <Problem failure={problem} />}
      {saved && (
        <Banner tone="info" title="Saved">
          Your insurance details were saved. The clinic checks them before your visit.
        </Banner>
      )}
      <ul className="pv-items" aria-label="Card photos">
        {slot('front', 'Front of the card')}
        {slot('back', 'Back of the card')}
      </ul>
      <form onSubmit={save} noValidate>
        <TextField
          id="ins-payer"
          label="Insurance company"
          value={payer}
          onChange={(e) => setPayer(e.target.value)}
          {...(errors.some((x) => x.fieldId === 'ins-payer')
            ? { error: 'Enter the insurance company' }
            : {})}
        />
        <TextField
          id="ins-member"
          label="Member ID"
          autoComplete="off"
          value={member}
          onChange={(e) => setMember(e.target.value)}
          {...(errors.some((x) => x.fieldId === 'ins-member')
            ? { error: 'Enter your member ID' }
            : {})}
        />
        <TextField
          id="ins-group"
          label="Group number"
          hint="Optional"
          autoComplete="off"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
        <div className="pv-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save insurance details'}
          </Button>
          <Button onClick={() => go(previsitPath(reservationId))}>Back to my pre-visit list</Button>
        </div>
      </form>
    </section>
  );
}
