import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  LoadingState,
  RefreshingContent,
  SelectField,
  StatusChip,
  TextAreaField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useElevation } from '../admin-auth/index.js';
import type { Failure } from '../preconsult/http.js';
import { fmtTime, useCompliance } from './context.js';
import { ActionError, LoadError, readAnswer } from './Problem.js';
import { adminStrings as s } from './strings.js';
import type { BtgGrant } from './types.js';

const STATUS_TEXT = {
  pending: s.btgPending,
  justified: s.btgJustified,
  not_justified: s.btgNotJustified,
};
const TONE = { pending: 'warning', justified: 'success', not_justified: 'danger' } as const;

type Load =
  | { kind: 'loading'; previous?: BtgGrant[] }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ok'; items: BtgGrant[]; next: string | null; more: boolean };

/** AD-02: break-the-glass grants and the second person's decision, justified or not with a required note (BR-14, AC-36). */
export function BtgReview() {
  const { api } = useCompliance();
  const { callPrivileged } = useElevation();
  const [filter, setFilter] = useState<'pending' | 'justified' | 'not_justified' | 'all'>(
    'pending',
  );
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<'justified' | 'not_justified' | ''>('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const out = await api.btgGrants(filter === 'all' ? '' : filter, cursor);
      return out;
    },
    [api, filter],
  );
  const reload = useCallback(async () => {
    setLoad((l) => ({ kind: 'loading', ...(l.kind === 'ok' ? { previous: l.items } : {}) }));
    const out = await fetchPage();
    setLoad(
      out.ok
        ? { kind: 'ok', items: out.data.items, next: out.data.nextCursor, more: false }
        : { kind: 'failed', failure: out },
    );
  }, [fetchPage]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const more = async () => {
    if (load.kind !== 'ok' || load.next === null) return;
    const out = await fetchPage(load.next);
    if (out.ok)
      setLoad({
        kind: 'ok',
        items: [...load.items, ...out.data.items],
        next: out.data.nextCursor,
        more: false,
      });
    else setLoad({ kind: 'failed', failure: out });
  };

  const items =
    load.kind === 'ok' ? load.items : load.kind === 'loading' ? load.previous : undefined;
  const grant = items?.find((g) => g.id === selected);

  const choose = (id: string) => {
    setSelected(id);
    setOutcome('');
    setNote('');
    setErrors([]);
    setFailure(undefined);
    setDone(undefined);
  };

  const submit = async () => {
    if (grant === undefined) return;
    const errs: FieldError[] = [];
    if (outcome === '') errs.push({ fieldId: 'btg-outcome', message: s.btgOutcomeRequired });
    if (note.trim().length < 10) errs.push({ fieldId: 'btg-note', message: s.btgNoteRequired });
    setErrors(errs);
    if (errs.length > 0 || outcome === '') return;
    setFailure(undefined);
    setBusy(true);
    try {
      const answer = await callPrivileged(
        {
          action: s.btgElevateAction,
          target: `Access opened ${fmtTime(grant.openedAt)}`,
          approver: null,
        },
        () => api.reviewBtgRaw(grant.id, outcome, note.trim()),
      );
      const r = await readAnswer(answer, (d) =>
        typeof d === 'object' && d !== null ? d : undefined,
      );
      if (r === undefined) return;
      if (!r.ok) return setFailure(r);
      setDone(s.btgDone(outcome === 'justified' ? s.btgJustified : s.btgNotJustified));
      setLoad((l) =>
        l.kind === 'ok'
          ? {
              ...l,
              items: l.items.map((g) => (g.id === grant.id ? { ...g, reviewStatus: outcome } : g)),
            }
          : l,
      );
    } finally {
      setBusy(false);
    }
  };

  const err = (f: string) => errors.find((e) => e.fieldId === f)?.message;
  return (
    <section aria-labelledby="btg-title">
      <h1 id="btg-title">{s.btgTitle}</h1>
      <p>{s.btgIntro}</p>
      <SelectField
        id="btg-filter"
        label={s.btgFilter}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value as typeof filter);
          setSelected(undefined);
        }}
      >
        <option value="pending">{s.btgPending}</option>
        <option value="justified">{s.btgJustified}</option>
        <option value="not_justified">{s.btgNotJustified}</option>
        <option value="all">{s.btgAll}</option>
      </SelectField>

      {load.kind === 'loading' && items === undefined && (
        <LoadingState label={s.loading} lines={4} />
      )}
      {load.kind === 'failed' && <LoadError failure={load.failure} onRetry={() => void reload()} />}
      {items !== undefined && (
        <RefreshingContent refreshing={load.kind === 'loading'}>
          {items.length === 0 ? (
            <EmptyState message={filter === 'pending' ? s.btgEmpty : s.btgEmptyFiltered} />
          ) : (
            <DataTable
              caption={s.btgTitle}
              rows={items}
              rowKey={(g) => g.id}
              onOpen={(g) => choose(g.id)}
              selectedKey={selected ?? ''}
              columns={[
                { key: 'opened', header: s.btgOpened, render: (g) => fmtTime(g.openedAt) },
                { key: 'holder', header: s.btgHolder, render: (g) => g.holderPersonId },
                { key: 'patient', header: s.btgPatient, render: (g) => g.patientId },
                { key: 'reason', header: s.btgReason, render: (g) => g.reason },
                {
                  key: 'status',
                  header: s.colStatus,
                  render: (g) => (
                    <StatusChip tone={TONE[g.reviewStatus]}>
                      {STATUS_TEXT[g.reviewStatus]}
                    </StatusChip>
                  ),
                },
                {
                  key: 'open',
                  header: '',
                  render: (g) => (
                    <Button
                      aria-label={`${s.open}: access opened ${fmtTime(g.openedAt)}`}
                      onClick={() => choose(g.id)}
                    >
                      {s.open}
                    </Button>
                  ),
                },
              ]}
            />
          )}
          {load.kind === 'ok' && load.next !== null && (
            <Button onClick={() => void more()}>{s.loadMore}</Button>
          )}
        </RefreshingContent>
      )}

      {grant !== undefined && (
        <section aria-labelledby="btg-detail" className="ehr-panel">
          <h2 id="btg-detail">{s.btgReviewHeading}</h2>
          <dl>
            <dt>{s.btgHolder}</dt>
            <dd>{grant.holderPersonId}</dd>
            <dt>{s.btgPatient}</dt>
            <dd>{grant.patientId}</dd>
            <dt>{s.btgReason}</dt>
            <dd>{grant.reason}</dd>
            <dt>{s.btgOpened}</dt>
            <dd>{fmtTime(grant.openedAt)}</dd>
            <dt>{s.btgExpires}</dt>
            <dd>{fmtTime(grant.expiresAt)}</dd>
            {grant.revokedAt !== null && (
              <>
                <dt>{s.btgRevoked}</dt>
                <dd>{fmtTime(grant.revokedAt)}</dd>
              </>
            )}
          </dl>
          {grant.reviewStatus !== 'pending' ? (
            <Banner tone="info">
              <p>
                {STATUS_TEXT[grant.reviewStatus]}.
                {grant.review !== null && ` ${s.btgReviewedBy(grant.review.reviewerPersonId)}.`}
              </p>
              {grant.review?.note != null && <p>{grant.review.note}</p>}
            </Banner>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              noValidate
            >
              {errors.length > 0 && <ErrorSummary errors={errors} />}
              <fieldset
                aria-describedby={err('btg-outcome') === undefined ? undefined : 'btg-outcome-err'}
              >
                <legend>{s.btgOutcome}</legend>
                <label>
                  <input
                    id="btg-outcome"
                    type="radio"
                    name="btg-outcome"
                    checked={outcome === 'justified'}
                    onChange={() => setOutcome('justified')}
                  />{' '}
                  {s.btgJustified}
                </label>
                <label>
                  <input
                    type="radio"
                    name="btg-outcome"
                    checked={outcome === 'not_justified'}
                    onChange={() => setOutcome('not_justified')}
                  />{' '}
                  {s.btgNotJustified}
                </label>
                {err('btg-outcome') !== undefined && (
                  <p id="btg-outcome-err" className="ehr-field__error">
                    {err('btg-outcome')}
                  </p>
                )}
              </fieldset>
              <TextAreaField
                id="btg-note"
                label={s.btgNote}
                hint={s.btgNoteHint}
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                {...(err('btg-note') === undefined ? {} : { error: err('btg-note') as string })}
              />
              <p>{s.btgKeyNote}</p>
              <Button type="submit" variant="primary" disabled={busy}>
                {s.btgSubmit}
              </Button>
            </form>
          )}
          {failure !== undefined && <ActionError failure={failure} />}
          {done !== undefined && (
            <Banner tone="info" announce>
              <p>{done}</p>
            </Banner>
          )}
        </section>
      )}
    </section>
  );
}
