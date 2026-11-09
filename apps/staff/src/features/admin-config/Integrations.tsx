import { useState } from 'react';
import { Banner, Button, DataTable, EmptyState, StatusChip, TextField } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { useConfig, usePrivileged, useRows } from './hooks.js';
import { ActionError, ListShell } from './Problem.js';
import { fmtTime } from './ResourceScreen.js';
import { configStrings as s } from './strings.js';
import { parseIntegration, parseTest, parseVersionId } from './types.js';
import type { Health, Integration } from './types.js';

const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TONE: Record<Health, 'neutral' | 'success' | 'warning' | 'danger'> = {
  unknown: 'neutral',
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
};
const nameOf = (i: Integration) => s.integrationNames[i.kind] ?? i.kind;

/**
 * One integration's panel: connection test and health, and a write-only secret. The secret value lives only in this component's
 * state while it is typed, is cleared the moment the request is sent, and the answer carries a version id, never the value.
 */
function Panel({
  item,
  onTested,
}: {
  item: Integration;
  onTested: (h: Health, at: string) => void;
}) {
  const { api } = useConfig();
  const run = usePrivileged();
  const [busy, setBusy] = useState<'test' | 'secret' | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [valueError, setValueError] = useState<string | undefined>();

  const test = async () => {
    setFailure(undefined);
    setNote(undefined);
    setBusy('test');
    try {
      const out = await run(
        { action: `Test ${nameOf(item)}`, target: nameOf(item), approver: null },
        () => api.testIntegration(item.id),
        parseTest,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      onTested(out.data.health, out.data.checkedAt);
      setNote(s.tested(s.health[out.data.health], fmtTime(out.data.checkedAt)));
    } finally {
      setBusy(undefined);
    }
  };
  const saveSecret = async () => {
    const n = name.trim();
    setNameError(SECRET_NAME.test(n) ? undefined : s.secretNameInvalid);
    setValueError(value === '' ? s.required : undefined);
    if (!SECRET_NAME.test(n) || value === '') return;
    setFailure(undefined);
    setNote(undefined);
    setBusy('secret');
    const sent = value;
    try {
      const out = await run(
        { action: `Set a secret for ${nameOf(item)}`, target: nameOf(item), approver: null },
        () => api.putSecret(item.id, n, sent),
        parseVersionId,
      );
      if (out === undefined) return; // cancelled: nothing was sent, the typed value stays for another try
      setValue(''); // sent: never keep it, whatever the answer
      if (!out.ok) return setFailure(out);
      setName('');
      setNote(s.secretSet(out.data));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="ehr-panel" aria-labelledby={`int-${item.id}`}>
      <h3 id={`int-${item.id}`}>{nameOf(item)}</h3>
      <p>
        <StatusChip tone={TONE[item.health]}>{s.health[item.health]}</StatusChip>{' '}
        {item.lastTestAt === null ? '' : `${s.colLastTest}: ${fmtTime(item.lastTestAt)}`}
      </p>
      <Button
        disabled={busy !== undefined}
        onClick={() => void test()}
        aria-label={`${s.testNow}: ${nameOf(item)}`}
      >
        {busy === 'test' ? s.testing : s.testNow}
      </Button>
      <form
        noValidate
        autoComplete="off"
        aria-labelledby={`sec-${item.id}`}
        onSubmit={(e) => {
          e.preventDefault();
          void saveSecret();
        }}
      >
        <h4 id={`sec-${item.id}`}>{`${s.secretHeading} (${s.secretWriteOnly})`}</h4>
        <TextField
          id={`secname-${item.id}`}
          label={s.secretName}
          hint={s.secretNameHint}
          value={name}
          maxLength={64}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          {...(nameError === undefined ? {} : { error: nameError })}
        />
        <TextField
          id={`secval-${item.id}`}
          label={s.secretValue}
          hint={s.secretValueHint}
          type="password"
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          {...(valueError === undefined ? {} : { error: valueError })}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy !== undefined}
          aria-label={`${s.save}: ${s.secretHeading} ${nameOf(item)}`}
        >
          {busy === 'secret' ? s.saving : s.save}
        </Button>
      </form>
      {failure !== undefined && <ActionError failure={failure} />}
      {note !== undefined && (
        <Banner tone="info" announce>
          <p>{note}</p>
        </Banner>
      )}
    </section>
  );
}

/** AD-09: integrations. The R1 connections with their health, a connection test, and write-only secrets (RA-R1-31). */
export function Integrations() {
  const rows = useRows('integrations', s.elevateRead);
  const [tests, setTests] = useState<Record<string, { health: Health; at: string }>>({});
  const items = rows.items
    ?.map((r) => parseIntegration(r))
    .filter((i): i is Integration => i !== undefined)
    .map((i) => {
      const t = tests[i.id];
      return t === undefined ? i : { ...i, health: t.health, lastTestAt: t.at };
    });

  return (
    <section aria-labelledby="integrations-title">
      <h1 id="integrations-title">{s.integrationsTitle}</h1>
      <p>{s.integrationsIntro}</p>
      <p>{s.auditNote}</p>
      <ListShell
        state={rows.state}
        items={items}
        reload={() => void rows.reload()}
        more={() => void rows.more()}
      >
        {items?.length === 0 ? (
          <EmptyState message={s.integrationsEmpty} />
        ) : (
          <>
            <DataTable
              caption={s.integrationsTitle}
              rows={items ?? []}
              rowKey={(i) => i.id}
              columns={[
                { key: 'name', header: s.integrationsTitle, render: nameOf },
                { key: 'vendor', header: 'Provider', render: (i) => i.vendor || s.none },
                { key: 'enabled', header: s.colEnabled, render: (i) => (i.enabled ? s.yes : s.no) },
                {
                  key: 'health',
                  header: s.colHealth,
                  render: (i) => (
                    <StatusChip tone={TONE[i.health]}>{s.health[i.health]}</StatusChip>
                  ),
                },
                { key: 'tested', header: s.colLastTest, render: (i) => fmtTime(i.lastTestAt) },
              ]}
            />
            {(items ?? []).map((i) => (
              <Panel
                key={i.id}
                item={i}
                onTested={(health, at) => setTests((p) => ({ ...p, [i.id]: { health, at } }))}
              />
            ))}
          </>
        )}
      </ListShell>
    </section>
  );
}
