import { useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, LoadingState, StatusChip, TextField } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { arr, str } from '../preconsult/http.js';
import { useConfig, usePrivileged, useRows } from './hooks.js';
import { ActionError } from './Problem.js';
import { configStrings as s } from './strings.js';
import { parseRow, text } from './types.js';
import type { Row } from './types.js';

const CODE = /^[A-Z]{2}$/;

interface Profile {
  principalId: string;
  displayName: string;
  licensedStates: string[];
}
function parseProfile(data: unknown): Profile | undefined {
  const r = parseRow(data);
  const principalId = r === undefined ? undefined : str(r['principalId']);
  if (r === undefined || principalId === undefined) return undefined;
  const states = arr(r['licensedStates']);
  return {
    principalId,
    displayName: str(r['displayName']) ?? '',
    licensedStates: states.filter((x): x is string => typeof x === 'string' && CODE.test(x)),
  };
}

/** The states the clinic operates telehealth in now: the latest row per state that has started (read-only reference). */
function operatingNow(rows: Row[], today: string): { code: string; allowed: boolean }[] {
  const latest = new Map<string, { from: string; allowed: boolean }>();
  for (const r of rows) {
    const code = text(r, 'jurisdictionCode');
    const from = text(r, 'effectiveFrom');
    if (code === '' || from === '' || from > today) continue;
    const have = latest.get(code);
    if (have === undefined || from > have.from)
      latest.set(code, { from, allowed: r['telehealthAllowed'] === true });
  }
  return [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, v]) => ({ code, allowed: v.allowed }));
}

/** Ruling C item 4: edit the states a clinician is licensed in. The server checks every booking and join against this table. */
export function LicensedStates() {
  const { api } = useConfig();
  const run = usePrivileged();
  const operating = useRows('operating-states', s.licElevateRead);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Row[] | undefined>();
  const [profile, setProfile] = useState<Profile | undefined | 'none'>();
  const [draft, setDraft] = useState<string[]>([]);
  const [add, setAdd] = useState('');
  const [addError, setAddError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [saved, setSaved] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      const out = await run(
        { action: s.licElevateRead, target: s.licTitle, approver: null },
        () =>
          api.list('principals', { realm: 'staff', ...(q.trim() === '' ? {} : { q: q.trim() }) }),
        (d) => {
          const items = arr(parseRow(d)?.['items']);
          return items.filter((i): i is Row => parseRow(i) !== undefined);
        },
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setFound(out.data);
    } finally {
      setBusy(false);
    }
  }

  async function open(principalId: string) {
    setBusy(true);
    setFailure(undefined);
    setSaved(false);
    try {
      const out = await run(
        { action: s.licElevateRead, target: s.licTitle, approver: null },
        () => api.licensedStates(principalId),
        parseProfile,
      );
      if (out === undefined) return;
      if (!out.ok) {
        if (out.status === 404) return setProfile('none');
        return setFailure(out);
      }
      setProfile(out.data);
      setDraft(out.data.licensedStates);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (profile === undefined || profile === 'none') return;
    setBusy(true);
    setFailure(undefined);
    setSaved(false);
    try {
      const out = await run(
        { action: s.licElevateSave, target: s.licTitle, approver: null },
        () => api.setLicensedStates(profile.principalId, draft),
        parseProfile,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setProfile(out.data);
      setDraft(out.data.licensedStates);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  function addState(e: FormEvent) {
    e.preventDefault();
    const code = add.trim().toUpperCase();
    if (!CODE.test(code)) return setAddError(s.licAddInvalid);
    setAddError(undefined);
    setAdd('');
    setSaved(false);
    setDraft((d) => (d.includes(code) ? d : [...d, code].sort()));
  }

  const same =
    profile !== undefined &&
    profile !== 'none' &&
    draft.length === profile.licensedStates.length &&
    draft.every((c) => profile.licensedStates.includes(c));
  const ops =
    operating.items === undefined
      ? []
      : operatingNow(operating.items, new Date().toISOString().slice(0, 10));

  return (
    <section aria-labelledby="lic-title">
      <h1 id="lic-title">{s.licTitle}</h1>
      <p>{s.licIntro}</p>
      <p>{s.auditNote}</p>
      {failure !== undefined && <ActionError failure={failure} />}

      <form onSubmit={(e) => void search(e)} aria-label="Search clinicians">
        <TextField
          id="lic-q"
          label={s.licFind}
          hint={s.licFindHint}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {s.licSearch}
        </Button>
      </form>
      {found !== undefined &&
        (found.length === 0 ? (
          <p>{s.licNoResult}</p>
        ) : (
          <ul aria-label="Clinicians found">
            {found.map((r) => (
              <li key={text(r, 'principalId')}>
                {text(r, 'displayName')}{' '}
                <Button
                  aria-label={`${s.licChoose} ${text(r, 'displayName')}`}
                  onClick={() => void open(text(r, 'principalId'))}
                >
                  {s.licChoose}
                </Button>
              </li>
            ))}
          </ul>
        ))}

      {profile === 'none' && <Banner tone="info">{s.licNoProfile}</Banner>}
      {profile !== undefined && profile !== 'none' && (
        <section aria-labelledby="lic-who">
          <h2 id="lic-who">{profile.displayName}</h2>
          {saved && <Banner tone="info">{s.licSaved}</Banner>}
          <fieldset>
            <legend>{s.licStatesLegend}</legend>
            {draft.length === 0 && <p>{s.licNone}</p>}
            <ul>
              {draft.map((c) => (
                <li key={c}>
                  {c}{' '}
                  <Button
                    aria-label={`${s.remove} ${c}`}
                    onClick={() => {
                      setSaved(false);
                      setDraft((d) => d.filter((x) => x !== c));
                    }}
                  >
                    {s.remove}
                  </Button>
                </li>
              ))}
            </ul>
          </fieldset>
          <form onSubmit={addState} aria-label="Add a licensed state">
            <TextField
              id="lic-add"
              label={s.licAddLabel}
              hint={s.licAddHint}
              maxLength={2}
              value={add}
              onChange={(e) => setAdd(e.target.value)}
              error={addError}
            />
            <Button type="submit">{s.licAdd}</Button>
          </form>
          <p>
            <Button
              variant="primary"
              disabled={busy || same}
              aria-busy={busy}
              onClick={() => void save()}
            >
              {busy ? s.saving : s.save}
            </Button>
          </p>
        </section>
      )}

      <h2>{s.licOperating}</h2>
      {operating.state.kind === 'loading' && operating.items === undefined ? (
        <LoadingState label={s.loading} lines={2} />
      ) : (
        <ul>
          {ops.map((o) => (
            <li key={o.code}>
              {o.code}{' '}
              <StatusChip tone={o.allowed ? 'success' : 'neutral'}>
                {o.allowed ? s.licOperatingAllowed : s.licOperatingOff}
              </StatusChip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
