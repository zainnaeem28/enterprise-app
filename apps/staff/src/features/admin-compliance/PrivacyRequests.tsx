import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  LoadingState,
  RefreshingContent,
  SelectField,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { fmtTime, useCompliance } from './context.js';
import type { PrivacyDecision } from './api.js';
import { ActionError, LoadError } from './Problem.js';
import { adminStrings as s } from './strings.js';
import type { PrivacyRequest, PrivacyStatus } from './types.js';

const TONE: Record<PrivacyStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  received: 'warning',
  identity_verified: 'info',
  in_progress: 'info',
  fulfilled: 'success',
  refused: 'danger',
  blocked_d8: 'warning',
};
const METHOD = /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{2,99}$/;

/** AD-05: the request queue and the decision. The list and the panel show request details and package metadata, never content (6.7). */
export function PrivacyRequests() {
  const { api } = useCompliance();
  const [status, setStatus] = useState('');
  const [load, setLoad] = useState<
    | { kind: 'loading'; previous?: PrivacyRequest[] }
    | { kind: 'failed'; failure: Failure }
    | { kind: 'ok'; items: PrivacyRequest[]; next: string | null }
  >({ kind: 'loading' });
  const [selected, setSelected] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoad((l) => ({ kind: 'loading', ...(l.kind === 'ok' ? { previous: l.items } : {}) }));
    const out = await api.privacyRequests(status);
    setLoad(
      out.ok
        ? { kind: 'ok', items: out.data.items, next: out.data.nextCursor }
        : { kind: 'failed', failure: out },
    );
  }, [api, status]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const more = async () => {
    if (load.kind !== 'ok' || load.next === null) return;
    const out = await api.privacyRequests(status, load.next);
    if (out.ok)
      setLoad({ kind: 'ok', items: [...load.items, ...out.data.items], next: out.data.nextCursor });
    else setLoad({ kind: 'failed', failure: out });
  };
  const replace = (r: PrivacyRequest) =>
    setLoad((l) =>
      l.kind === 'ok' ? { ...l, items: l.items.map((x) => (x.id === r.id ? r : x)) } : l,
    );

  const items =
    load.kind === 'ok' ? load.items : load.kind === 'loading' ? load.previous : undefined;
  const current = items?.find((r) => r.id === selected);

  return (
    <section aria-labelledby="privacy-title">
      <h1 id="privacy-title">{s.privacyTitle}</h1>
      <p>{s.privacyIntro}</p>
      <SelectField
        id="privacy-status"
        label={s.privacyStatus}
        value={status}
        onChange={(e) => {
          setStatus(e.target.value);
          setSelected(undefined);
        }}
      >
        <option value="">{s.privacyAll}</option>
        {Object.entries(s.pStatus).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </SelectField>
      {load.kind === 'loading' && items === undefined && (
        <LoadingState label={s.loading} lines={4} />
      )}
      {load.kind === 'failed' && <LoadError failure={load.failure} onRetry={() => void reload()} />}
      {items !== undefined && (
        <RefreshingContent refreshing={load.kind === 'loading'}>
          {items.length === 0 ? (
            <EmptyState
              message={status === '' ? s.privacyEmpty : s.privacyEmptyFiltered}
              filtered={status !== ''}
              onClearFilters={() => setStatus('')}
            />
          ) : (
            <DataTable
              caption={s.privacyTitle}
              rows={items}
              rowKey={(r) => r.id}
              selectedKey={selected ?? ''}
              onOpen={(r) => setSelected(r.id)}
              columns={[
                { key: 'kind', header: s.colKind, render: (r) => s.kind[r.kind] ?? r.kind },
                {
                  key: 'status',
                  header: s.colStatus,
                  render: (r) => (
                    <StatusChip tone={TONE[r.status]}>{s.pStatus[r.status]}</StatusChip>
                  ),
                },
                { key: 'received', header: s.colReceived, render: (r) => fmtTime(r.createdAt) },
                { key: 'due', header: s.colDue, render: (r) => fmtTime(r.dueAt) },
                {
                  key: 'open',
                  header: '',
                  render: (r) => (
                    <Button
                      aria-label={`${s.open}: ${s.kind[r.kind] ?? r.kind} request received ${fmtTime(r.createdAt)}`}
                      onClick={() => setSelected(r.id)}
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
      {current !== undefined && (
        <RequestPanel
          key={current.id}
          request={current}
          onChanged={replace}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}

function RequestPanel({
  request: r,
  onChanged,
  onClose,
}: {
  request: PrivacyRequest;
  onChanged: (r: PrivacyRequest) => void;
  onClose: () => void;
}) {
  const { api } = useCompliance();
  const [method, setMethod] = useState('');
  const [methodError, setMethodError] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const final = r.status === 'fulfilled' || r.status === 'refused';
  const verified = r.verifiedAt !== null;
  const canVerify = !verified && (r.status === 'received' || r.status === 'blocked_d8');
  const onHold = r.status === 'blocked_d8';

  const verify = async () => {
    if (!METHOD.test(method.trim())) return setMethodError(s.verifyMethodInvalid);
    setMethodError(undefined);
    setFailure(undefined);
    setBusy(true);
    const out = await api.verifyIdentity(r.id, method.trim(), r.version);
    setBusy(false);
    if (!out.ok) return setFailure(out);
    onChanged(out.data);
    setDone(
      s.verifiedOn(out.data.verificationMethod ?? method.trim(), fmtTime(out.data.verifiedAt)),
    );
  };
  const decide = async (d: PrivacyDecision) => {
    const text = reason.trim();
    if (
      (d === 'refuse' && (text.length < 10 || text.length > 2000)) ||
      (text !== '' && (text.length < 10 || text.length > 2000))
    )
      return setReasonError(s.decideReasonShort);
    setReasonError(undefined);
    setFailure(undefined);
    setBusy(true);
    const out = await api.decidePrivacy(r.id, d, text, r.version);
    setBusy(false);
    if (!out.ok) return setFailure(out);
    onChanged(out.data);
    setDone(s.decided(s.pStatus[out.data.status] ?? out.data.status));
  };

  return (
    <section aria-labelledby="pr-title" className="ehr-panel">
      <h2 id="pr-title">{`${s.kind[r.kind] ?? r.kind}: ${s.pStatus[r.status]}`}</h2>
      <dl>
        <dt>{s.patient}</dt>
        <dd>{r.patientId}</dd>
        <dt>{s.colReceived}</dt>
        <dd>{fmtTime(r.createdAt)}</dd>
        <dt>{s.colDue}</dt>
        <dd>{fmtTime(r.dueAt)}</dd>
        {r.detail !== null && (
          <>
            <dt>Details from the patient</dt>
            <dd>{r.detail}</dd>
          </>
        )}
        {r.decisionReason !== null && (
          <>
            <dt>{s.decideReason}</dt>
            <dd>{r.decisionReason}</dd>
          </>
        )}
      </dl>
      {onHold && (
        <Banner tone="warning">
          <p>{s.deletionHold}</p>
        </Banner>
      )}
      {r.legalHold !== null && <p>{s.legalHold(r.legalHold.documents)}</p>}
      <h3>{s.packageHeading}</h3>
      {r.package === null ? (
        <p>{s.packageNone}</p>
      ) : (
        <p>
          {s.packageStatus(r.package.status)}
          {r.package.failureCode !== null && ` — ${s.packageFailed(r.package.failureCode)}`}
        </p>
      )}

      {verified ? (
        <p>{s.verifiedOn(r.verificationMethod ?? '', fmtTime(r.verifiedAt))}</p>
      ) : (
        canVerify && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <h3>{s.verifyHeading}</h3>
            <TextField
              id="verify-method"
              label={s.verifyMethod}
              hint={s.verifyHint}
              value={method}
              maxLength={100}
              onChange={(e) => setMethod(e.target.value)}
              {...(methodError === undefined ? {} : { error: methodError })}
            />
            <Button type="submit" disabled={busy}>
              {s.verifySubmit}
            </Button>
          </form>
        )
      )}

      {!final && (
        <div>
          <h3>{s.decideHeading}</h3>
          {!verified && !onHold && <p>{s.notVerified}</p>}
          <TextAreaField
            id="decide-reason"
            label={s.decideReason}
            hint={s.decideReasonHint}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            {...(reasonError === undefined ? {} : { error: reasonError })}
          />
          {r.status === 'identity_verified' && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void decide('approve')}>
                {s.approveReq}
              </Button>{' '}
            </>
          )}
          {r.status === 'in_progress' && r.kind === 'correction' && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void decide('fulfil')}>
                {s.fulfilReq}
              </Button>{' '}
            </>
          )}
          {r.status === 'in_progress' && r.package?.status === 'failed' && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void decide('retry')}>
                {s.retryReq}
              </Button>{' '}
            </>
          )}
          <Button disabled={busy} onClick={() => void decide('refuse')}>
            {s.refuseReq}
          </Button>
        </div>
      )}
      {failure !== undefined && <ActionError failure={failure} />}
      {done !== undefined && (
        <Banner tone="info" announce>
          <p>{done}</p>
        </Banner>
      )}
      <Button onClick={onClose}>{s.close}</Button>
    </section>
  );
}
