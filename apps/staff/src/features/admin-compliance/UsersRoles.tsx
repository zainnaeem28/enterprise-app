import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  FilterBar,
  LoadingState,
  RefreshingContent,
  SelectField,
  StatusChip,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useElevation } from '../admin-auth/index.js';
import type { Failure } from '../preconsult/http.js';
import { parseRoleChange } from './api.js';
import { UUID, fmtTime, useCompliance } from './context.js';
import { ActionError, LoadError, readAnswer } from './Problem.js';
import { adminStrings as s } from './strings.js';
import type { Principal, Role, RoleChange, RoleRef } from './types.js';

const STATUS: Record<string, string> = {
  requested: s.statusRequested,
  approved: s.statusApproved,
  rejected: s.statusRejected,
  cancelled: s.statusCancelled,
  expired: s.statusExpired,
};
const roleText = (r: RoleRef) =>
  r.locationId === undefined ? r.roleKey : `${r.roleKey} (${r.locationId})`;

/**
 * AD-03: users, roles, the role change request and the approval screen. The two-person rule is the server's (ARCHITECTURE 26,
 * C4): requester ≠ approver and approver ≠ subject. The screens say so before the click and translate the refusal after it.
 */
export function UsersRoles() {
  const { api } = useCompliance();
  const [q, setQ] = useState('');
  const [realm, setRealm] = useState('');
  const [applied, setApplied] = useState({ q: '', realm: '' });
  const [list, setList] = useState<
    | { kind: 'loading'; previous?: Principal[] }
    | { kind: 'failed'; failure: Failure }
    | { kind: 'ok'; items: Principal[]; next: string | null }
  >({ kind: 'loading' });
  const [roles, setRoles] = useState<Role[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [mine, setMine] = useState<RoleChange[]>([]);

  const load = useCallback(async () => {
    setList((l) => ({ kind: 'loading', ...(l.kind === 'ok' ? { previous: l.items } : {}) }));
    const out = await api.principals(applied.q, applied.realm);
    setList(
      out.ok
        ? { kind: 'ok', items: out.data.items, next: out.data.nextCursor }
        : { kind: 'failed', failure: out },
    );
  }, [api, applied]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api.roles().then((o) => o.ok && setRoles(o.data.items));
  }, [api]);

  const more = async () => {
    if (list.kind !== 'ok' || list.next === null) return;
    const out = await api.principals(applied.q, applied.realm, list.next);
    if (out.ok)
      setList({ kind: 'ok', items: [...list.items, ...out.data.items], next: out.data.nextCursor });
    else setList({ kind: 'failed', failure: out });
  };

  const items =
    list.kind === 'ok' ? list.items : list.kind === 'loading' ? list.previous : undefined;
  const subject = items?.find((p) => p.principalId === selected);
  const filtered = applied.q !== '' || applied.realm !== '';

  return (
    <section aria-labelledby="users-title">
      <h1 id="users-title">{s.usersTitle}</h1>
      <p>{s.usersIntro}</p>
      <FilterBar
        label={s.usersTitle}
        onApply={() => setApplied({ q: q.trim(), realm })}
        onClear={() => {
          setQ('');
          setRealm('');
          setApplied({ q: '', realm: '' });
        }}
      >
        <TextField
          id="user-q"
          label={s.userSearch}
          value={q}
          maxLength={64}
          onChange={(e) => setQ(e.target.value)}
        />
        <SelectField
          id="user-realm"
          label={s.realmFilter}
          value={realm}
          onChange={(e) => setRealm(e.target.value)}
        >
          <option value="">{s.realmAll}</option>
          <option value="admin_pool">{s.realmAdmin}</option>
          <option value="google">{s.realmStaff}</option>
        </SelectField>
      </FilterBar>
      {list.kind === 'loading' && items === undefined && (
        <LoadingState label={s.loading} lines={4} />
      )}
      {list.kind === 'failed' && <LoadError failure={list.failure} onRetry={() => void load()} />}
      {items !== undefined && (
        <RefreshingContent refreshing={list.kind === 'loading'}>
          {items.length === 0 ? (
            <EmptyState
              message={filtered ? s.usersEmptyFiltered : s.usersEmpty}
              filtered={filtered}
              onClearFilters={() => {
                setQ('');
                setRealm('');
                setApplied({ q: '', realm: '' });
              }}
            />
          ) : (
            <DataTable
              caption={s.usersTitle}
              rows={items}
              rowKey={(p) => p.principalId}
              selectedKey={selected ?? ''}
              onOpen={(p) => setSelected(p.principalId)}
              columns={[
                { key: 'name', header: s.colName, render: (p) => p.displayName },
                { key: 'signin', header: s.colSignIn, render: (p) => p.handle ?? p.email ?? '—' },
                {
                  key: 'realm',
                  header: s.realmFilter,
                  render: (p) => (p.realm === 'admin_pool' ? s.realmAdmin : s.realmStaff),
                },
                {
                  key: 'status',
                  header: s.colStatus,
                  render: (p) => (
                    <StatusChip tone={p.status === 'active' ? 'success' : 'neutral'}>
                      {p.status}
                    </StatusChip>
                  ),
                },
                {
                  key: 'act',
                  header: '',
                  render: (p) => (
                    <Button
                      aria-label={`${s.requestChange}: ${p.displayName}`}
                      onClick={() => setSelected(p.principalId)}
                    >
                      {s.requestChange}
                    </Button>
                  ),
                },
              ]}
            />
          )}
          {list.kind === 'ok' && list.next !== null && (
            <Button onClick={() => void more()}>{s.loadMore}</Button>
          )}
        </RefreshingContent>
      )}

      {subject !== undefined && (
        <RoleChangeForm
          key={subject.principalId}
          subject={subject}
          roles={roles}
          onSent={(c) => setMine((m) => [c, ...m])}
        />
      )}
      <Approvals
        mine={mine}
        onChange={(c) => setMine((m) => m.map((x) => (x.id === c.id ? c : x)))}
      />
    </section>
  );
}

function RoleChangeForm({
  subject,
  roles,
  onSent,
}: {
  subject: Principal;
  roles: Role[];
  onSent: (c: RoleChange) => void;
}) {
  const { api } = useCompliance();
  const { callPrivileged } = useElevation();
  const fit = roles.filter((r) => r.realm === subject.realm);
  const [add, setAdd] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [sent, setSent] = useState<RoleChange | undefined>();

  const toggle = (set: typeof setAdd, key: string, on: boolean) =>
    set((m) => {
      const n = { ...m };
      if (on) n[key] = '';
      else delete n[key];
      return n;
    });
  const refs = (m: Record<string, string>): RoleRef[] =>
    Object.entries(m).map(([roleKey, loc]) =>
      loc.trim() === '' ? { roleKey } : { roleKey, locationId: loc.trim().toLowerCase() },
    );

  const submit = async () => {
    const errs: FieldError[] = [];
    if (Object.keys(add).length + Object.keys(remove).length === 0)
      errs.push({ fieldId: 'role-add-0', message: s.changeNeeds });
    for (const [group, m] of [
      ['add', add],
      ['remove', remove],
    ] as const)
      for (const [key, loc] of Object.entries(m)) {
        const role = fit.find((r) => r.key === key);
        if (role?.locationBound === true && !UUID.test(loc.trim()))
          errs.push({ fieldId: `loc-${group}-${key}`, message: s.notReference });
      }
    setErrors(errs);
    if (errs.length > 0) return;
    setFailure(undefined);
    setBusy(true);
    try {
      const answer = await callPrivileged(
        { action: s.changeElevateAction, target: subject.displayName, approver: s.changeApprover },
        () => api.requestRoleChangeRaw(subject.principalId, refs(add), refs(remove)),
      );
      const r = await readAnswer(answer, parseRoleChange);
      if (r === undefined) return;
      if (!r.ok) return setFailure(r);
      setSent(r.data);
      onSent(r.data);
    } finally {
      setBusy(false);
    }
  };
  const err = (f: string) => errors.find((e) => e.fieldId === f)?.message;
  const list = (
    group: 'add' | 'remove',
    m: Record<string, string>,
    set: typeof setAdd,
    legend: string,
  ) => (
    <fieldset>
      <legend>{legend}</legend>
      {fit.length === 0 && <p>{s.rolesNone}</p>}
      {fit.map((r, i) => (
        <div key={r.key}>
          <label>
            <input
              id={group === 'add' && i === 0 ? 'role-add-0' : undefined}
              type="checkbox"
              checked={r.key in m}
              onChange={(e) => toggle(set, r.key, e.target.checked)}
            />{' '}
            {r.key}
            {r.privileged && <> — {s.privilegedNote}</>}
          </label>
          {r.key in m && r.locationBound && (
            <TextField
              id={`loc-${group}-${r.key}`}
              label={s.locationFor(r.key)}
              hint={s.locationHint}
              value={m[r.key] ?? ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set((x) => ({ ...x, [r.key]: e.target.value }))}
              {...(err(`loc-${group}-${r.key}`) === undefined
                ? {}
                : { error: err(`loc-${group}-${r.key}`) as string })}
            />
          )}
        </div>
      ))}
    </fieldset>
  );

  return (
    <section aria-labelledby="rc-title" className="ehr-panel">
      <h2 id="rc-title">{`${s.requestChange}: ${subject.displayName}`}</h2>
      {subject.handle === null && subject.realm === 'google' && <p>{s.notYetSignedIn}</p>}
      <Banner tone="info">
        <p>{s.twoPerson}</p>
      </Banner>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {errors.length > 0 && <ErrorSummary errors={errors} />}
        {list('add', add, setAdd, s.rolesAdd)}
        {list('remove', remove, setRemove, s.rolesRemove)}
        <Button type="submit" variant="primary" disabled={busy}>
          {s.changeSubmit}
        </Button>
      </form>
      {failure !== undefined && <ActionError failure={failure} />}
      {sent !== undefined && (
        <Banner tone="info" announce>
          <p>{s.changeSent}</p>
          <p>
            {s.changeSentRef}: <code>{sent.id}</code>
          </p>
          <p>{s.changeExpires(fmtTime(sent.expiresAt))}</p>
        </Banner>
      )}
    </section>
  );
}

function Approvals({ mine, onChange }: { mine: RoleChange[]; onChange: (c: RoleChange) => void }) {
  const { api } = useCompliance();
  const { callPrivileged } = useElevation();
  const [ref, setRef] = useState('');
  const [refError, setRefError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [result, setResult] = useState<string | undefined>();
  const own = mine.find((m) => m.id === ref.trim().toLowerCase());

  const decide = async (id: string, decision: 'approve' | 'reject' | 'cancel') => {
    setFailure(undefined);
    setResult(undefined);
    setBusy(true);
    try {
      const target = mine.find((m) => m.id === id);
      const answer = await callPrivileged(
        {
          action:
            decision === 'approve'
              ? s.approveElevate
              : decision === 'reject'
                ? s.rejectElevate
                : s.cancelRequest,
          target:
            target === undefined
              ? `Request ${id}`
              : `Request for ${target.add.map(roleText).concat(target.remove.map(roleText)).join(', ')}`,
          approver: null,
        },
        () => api.decideRoleChangeRaw(id, decision),
      );
      const r = await readAnswer(answer, parseRoleChange);
      if (r === undefined) return;
      if (!r.ok) return setFailure(r);
      onChange(r.data);
      setResult(
        decision === 'approve'
          ? s.approvedDone
          : decision === 'reject'
            ? s.rejectedDone
            : s.cancelledDone,
      );
    } finally {
      setBusy(false);
    }
  };
  const act = (decision: 'approve' | 'reject') => {
    const id = ref.trim().toLowerCase();
    if (!UUID.test(id)) return setRefError(s.notReference);
    setRefError(undefined);
    void decide(id, decision);
  };

  return (
    <section aria-labelledby="appr-title" className="ehr-panel">
      <h2 id="appr-title">{s.approvalsTitle}</h2>
      <p>{s.approvalsIntro}</p>
      <TextField
        id="approval-ref"
        label={s.approvalRef}
        hint={s.approvalRefHint}
        value={ref}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setRef(e.target.value)}
        {...(refError === undefined ? {} : { error: refError })}
      />
      {own !== undefined && own.status === 'requested' && (
        <Banner tone="warning">
          <p>{s.ownRequestWaiting}</p>
        </Banner>
      )}
      <Button variant="primary" disabled={busy || own !== undefined} onClick={() => act('approve')}>
        {s.approve}
      </Button>{' '}
      <Button disabled={busy || own !== undefined} onClick={() => act('reject')}>
        {s.reject}
      </Button>
      {failure !== undefined && <ActionError failure={failure} />}
      {result !== undefined && (
        <Banner tone="info" announce>
          <p>{result}</p>
        </Banner>
      )}
      <h3>{s.mine}</h3>
      {mine.length === 0 ? (
        <p>{s.mineNone}</p>
      ) : (
        <ul>
          {mine.map((m) => (
            <li key={m.id}>
              <StatusChip tone={m.status === 'requested' ? 'warning' : 'neutral'}>
                {STATUS[m.status] ?? m.status}
              </StatusChip>{' '}
              {[
                ...m.add.map((r) => `${s.added} ${roleText(r)}`),
                ...m.remove.map((r) => `${s.removed} ${roleText(r)}`),
              ].join(', ')}{' '}
              — <code>{m.id}</code>
              {m.status === 'requested' && (
                <>
                  {' '}
                  <Button disabled={busy} onClick={() => void decide(m.id, 'cancel')}>
                    {s.cancelRequest}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
