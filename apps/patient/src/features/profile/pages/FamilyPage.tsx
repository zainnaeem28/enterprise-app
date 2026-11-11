import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Banner,
  Button,
  EmptyState,
  LoadingState,
  RefreshingContent,
  SelectField,
  StatusChip,
} from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import type { Failure } from '../lib/core.js';
import { useAccountCtx } from '../lib/ctx.js';
import { useSubmit } from '../lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../lib/hooks.js';
import type { Person } from '../lib/hooks.js';
import { Problem } from '../lib/Problem.js';
import { PROXY_SCOPES } from '../types.js';
import type { ProxyGrant, ProxyScope, ProxyStatus } from '../types.js';

const SCOPE_LABEL: Record<ProxyScope, string> = {
  appointments: 'Appointments',
  messages: 'Messages',
  documents: 'Documents',
};
const DAY = 86_400_000;

/** Whole days from today until `YYYY-MM-DD` (negative once past). Date only: no time zone is guessed. */
export function daysUntil(date: string, now: Date = new Date()): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return undefined;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - today) / DAY);
}

/** The 30-day notice that a grant ends (age rules): shown from the grant's own `validUntil`, never from a guessed age. */
export function ageOutNotice(g: ProxyGrant, now: Date = new Date()): string | undefined {
  if (g.validUntil === undefined || g.status === 'revoked' || g.status === 'expired')
    return undefined;
  const d = daysUntil(g.validUntil, now);
  if (d === undefined || d < 0 || d > 30) return undefined;
  return d === 0
    ? 'This access ends today.'
    : `This access ends on ${g.validUntil} (in ${d} ${d === 1 ? 'day' : 'days'}).`;
}

/** What a linked person may see (ruling C item 3). Appointments are always on; messages and documents are the patient's choice. */
function ScopeEditor({
  grant,
  onSave,
  busy,
}: {
  grant: ProxyGrant;
  onSave: (scopes: ProxyScope[]) => void;
  busy: boolean;
}) {
  const [picked, setPicked] = useState<ProxyScope[]>(grant.scopes);
  const limited = grant.effectiveScopes.length < grant.scopes.length;
  const same =
    picked.length === grant.scopes.length && picked.every((x) => grant.scopes.includes(x));
  const legend = `What ${grant.patientDisplayName || RELATION[grant.relationship]} can see`;
  return (
    <fieldset>
      <legend>{legend}</legend>
      {PROXY_SCOPES.map((sc) => (
        <p key={sc}>
          <label>
            <input
              type="checkbox"
              checked={sc === 'appointments' || picked.includes(sc)}
              disabled={sc === 'appointments' || grant.guardian}
              onChange={(e) =>
                setPicked((cur) => (e.target.checked ? [...cur, sc] : cur.filter((x) => x !== sc)))
              }
            />{' '}
            {SCOPE_LABEL[sc]}
          </label>
        </p>
      ))}
      {grant.guardian ? (
        <p className="profile-note">The clinic manages this link. Ask the clinic to change it.</p>
      ) : (
        <Button disabled={busy || same} aria-busy={busy} onClick={() => onSave(picked)}>
          Save what they can see
        </Button>
      )}
      {limited && (
        <p className="profile-note">
          Some of this is paused for now because of the age rules, so they see less than is ticked.
        </p>
      )}
    </fieldset>
  );
}

/** PP-08: each status is text + icon + colour (UX-R9), with what happens next. */
const STATUS: Record<ProxyStatus, { tone: Tone; label: string; next: string }> = {
  invited: {
    tone: 'warning',
    label: 'Invitation sent',
    next: 'They need to enter the code from the email we sent them. Nothing is shared until they do.',
  },
  requested: {
    tone: 'warning',
    label: 'Waiting for the clinic to check',
    next: 'The clinic will check who this person is before they can see anything.',
  },
  verified: {
    tone: 'info',
    label: 'Checked, not active yet',
    next: 'The clinic has checked this person. Access starts when the link is switched on.',
  },
  active: {
    tone: 'success',
    label: 'Active',
    next: 'They can see what is ticked below.',
  },
  revoked: { tone: 'neutral', label: 'Removed', next: 'This person can no longer see anything.' },
  expired: {
    tone: 'neutral',
    label: 'Ended',
    next: 'This link has ended. Ask again if it is still needed.',
  },
};
const RELATION: Record<string, string> = {
  parent: 'Parent',
  guardian: 'Guardian',
  carer: 'Carer',
  other: 'Other',
};

export const personLabel = (p: Person, index: number): string =>
  p.relation === 'self' ? 'Me' : (p.displayName ?? `Person ${index}`);

/** PP-09: the header chip "Booking for: …" with a switch. Exported so the app can mount it in the header. */
export function PersonChip({
  people,
  activeId,
  onChange,
}: {
  people: Person[];
  activeId: string | undefined;
  onChange: (id: string) => void;
}) {
  if (people.length < 2) return null;
  let others = 0;
  const labelled = people.map((p) => ({
    p,
    label: personLabel(p, p.relation === 'self' ? 0 : ++others),
  }));
  return (
    <SelectField
      label="Booking for"
      id="person-chip"
      value={activeId ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {labelled.map(({ p, label }) => (
        <option key={p.patientId} value={p.patientId}>
          {label}
        </option>
      ))}
    </SelectField>
  );
}

/** PP-06 family and proxy list, with PP-08 status and PP-09 switch person. A proxy sees appointments only (D-7 default). */
export function FamilyPage() {
  const { api, selfId, people, activeId, setActiveId, go } = useAccountCtx();
  const [grants, setGrants] = useState<ProxyGrant[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<ProxyGrant | undefined>();
  const [removeFailure, setRemoveFailure] = useState<Failure | undefined>();
  const [removed, setRemoved] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveFailure, setSaveFailure] = useState<Failure | undefined>();
  const [leaving, setLeaving] = useState<{ grantId: string; label: string } | undefined>();
  const [left, setLeft] = useState(false);
  const [leaveFailure, setLeaveFailure] = useState<Failure | undefined>();
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Family and access');

  const load = useCallback(async () => {
    if (selfId === undefined) return setGrants([]);
    setRefreshing(true);
    const r = await api.proxies(selfId);
    setRefreshing(false);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setGrants(r.data);
  }, [api, selfId]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (grants ?? []).filter((g) => g.status !== 'revoked' && g.status !== 'expired');
  const past = (grants ?? []).filter((g) => g.status === 'revoked' || g.status === 'expired');
  const acting = people.filter((p) => p.relation === 'proxy');

  async function remove() {
    if (removing === undefined || selfId === undefined) return;
    await run(async () => {
      const r = await api.revokeProxy(selfId, removing.id);
      setRemoving(undefined);
      if (r.ok) {
        setRemoved(true);
        setRemoveFailure(undefined);
        return load();
      }
      setRemoveFailure(r);
    });
  }

  async function saveScopes(g: ProxyGrant, scopes: ProxyScope[]) {
    if (selfId === undefined) return;
    await run(async () => {
      setSaved(false);
      const r = await api.setProxyScopes(selfId, g.id, scopes);
      if (r.ok) {
        setSaveFailure(undefined);
        setSaved(true);
        return load();
      }
      setSaveFailure(r);
    });
  }

  async function leave() {
    if (leaving === undefined) return;
    await run(async () => {
      const r = await api.leaveProxy(leaving.grantId);
      setLeaving(undefined);
      if (r.ok) {
        setLeft(true);
        setLeaveFailure(undefined);
        return;
      }
      setLeaveFailure(r);
    });
  }

  return (
    <section aria-labelledby="family-h" className="ehr-card profile">
      <h1 id="family-h" ref={heading} tabIndex={-1}>
        Family and access
      </h1>
      <Banner tone="info" announce={false}>
        A person you link can see your appointments. You choose whether they can also see your
        messages and your documents. They cannot see anything else, such as test results.
      </Banner>
      {saved && <Banner tone="info">Saved. What they can see has changed.</Banner>}
      {saveFailure !== undefined && (
        <Problem failure={saveFailure} onRetry={() => setSaveFailure(undefined)} />
      )}
      {left && (
        <Banner tone="info">
          You left. You can no longer see that person&apos;s appointments. Sign in again to refresh
          the list of people you act for.
        </Banner>
      )}
      {leaveFailure !== undefined && (
        <Problem failure={leaveFailure} onRetry={() => setLeaveFailure(undefined)} />
      )}
      {removed && (
        <Banner tone="info">
          Access was removed. That person can no longer see your appointments.
        </Banner>
      )}
      {removeFailure !== undefined && (
        <Problem failure={removeFailure} onRetry={() => setRemoveFailure(undefined)} />
      )}

      <h2>People who can see your appointments</h2>
      {failure !== undefined && grants === undefined ? (
        <Problem failure={failure} onRetry={() => void load()} />
      ) : grants === undefined ? (
        <LoadingState label="Loading" lines={3} />
      ) : selfId === undefined ? (
        <p>Your account does not have a record of its own, so nobody can be linked to it.</p>
      ) : open.length === 0 ? (
        <EmptyState
          message="Nobody else can see your appointments."
          action={
            <Button variant="primary" onClick={() => go('/family/add')}>
              Link a family member
            </Button>
          }
        />
      ) : (
        <RefreshingContent refreshing={refreshing}>
          <ul className="profile-list">
            {open.map((g) => (
              <li key={g.id} className="profile-item">
                <p>
                  <strong>{g.patientDisplayName || RELATION[g.relationship]}</strong> (
                  {RELATION[g.relationship]})
                </p>
                <p>
                  <StatusChip tone={STATUS[g.status].tone}>{STATUS[g.status].label}</StatusChip>
                </p>
                <p className="profile-note">{STATUS[g.status].next}</p>
                {g.inviteeHint !== undefined && (
                  <p className="profile-note">Sent to {g.inviteeHint}.</p>
                )}
                {ageOutNotice(g) !== undefined && (
                  <Banner tone="warning" announce={false}>
                    {ageOutNotice(g)}
                  </Banner>
                )}
                {g.status === 'active' && (
                  <ScopeEditor
                    key={`${g.id}:${g.scopes.join(',')}`}
                    grant={g}
                    busy={busy}
                    onSave={(sc) => void saveScopes(g, sc)}
                  />
                )}
                <Button onClick={() => setRemoving(g)}>
                  {g.status === 'invited' ? 'Cancel invitation' : 'Remove access'}
                </Button>
              </li>
            ))}
          </ul>
          <p>
            <Button variant="primary" onClick={() => go('/family/add')}>
              Link a family member
            </Button>
          </p>
        </RefreshingContent>
      )}
      {past.length > 0 && (
        <details>
          <summary>Earlier links ({past.length})</summary>
          <ul className="profile-list">
            {past.map((g) => (
              <li key={g.id} className="profile-item">
                {g.patientDisplayName || RELATION[g.relationship]} ({RELATION[g.relationship]}):{' '}
                <StatusChip tone={STATUS[g.status].tone}>{STATUS[g.status].label}</StatusChip>
              </li>
            ))}
          </ul>
        </details>
      )}

      {acting.length > 0 && (
        <>
          <h2>People you act for</h2>
          <p className="profile-note">You see what each person chose to share with you.</p>
          <PersonChip people={people} activeId={activeId} onChange={setActiveId} />
          <ul className="profile-list">
            {(() => {
              let n = 0;
              return acting.map((p) => {
                n += 1;
                return (
                  <li key={p.patientId} className="profile-item">
                    <strong>{personLabel(p, n)}</strong>{' '}
                    <StatusChip tone="info">Appointments</StatusChip>
                    {p.grantId !== undefined && (
                      <Button
                        onClick={() =>
                          setLeaving({ grantId: p.grantId as string, label: personLabel(p, n) })
                        }
                      >
                        Leave
                      </Button>
                    )}{' '}
                    {activeId === p.patientId ? (
                      <StatusChip tone="success">Booking for this person</StatusChip>
                    ) : (
                      <Button onClick={() => setActiveId(p.patientId)}>Book for this person</Button>
                    )}
                  </li>
                );
              });
            })()}
          </ul>
        </>
      )}

      {leaving !== undefined && (
        <AlertDialog
          title="Leave this person's account?"
          initialFocus="[data-keep]"
          actions={
            <>
              <Button data-keep onClick={() => setLeaving(undefined)}>
                Stay linked
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void leave()}
              >
                Leave
              </Button>
            </>
          }
        >
          <p>
            You will stop seeing {leaving.label}&apos;s appointments straight away. They can invite
            you again later.
          </p>
        </AlertDialog>
      )}
      {removing !== undefined && (
        <AlertDialog
          title="Remove access?"
          initialFocus="[data-keep]"
          actions={
            <>
              <Button data-keep onClick={() => setRemoving(undefined)}>
                Keep access
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void remove()}
              >
                Remove access
              </Button>
            </>
          }
        >
          <p>
            This person will no longer be able to see your appointments. You can link them again
            later.
          </p>
        </AlertDialog>
      )}
    </section>
  );
}
