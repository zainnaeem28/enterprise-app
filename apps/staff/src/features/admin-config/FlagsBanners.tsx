import { useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  SelectField,
  StatusChip,
  TextField,
} from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { usePrivileged, useConfig, useRows } from './hooks.js';
import { ActionError, ListShell } from './Problem.js';
import { ResourceScreen } from './ResourceScreen.js';
import { BANNERS } from './specs.js';
import { configStrings as s } from './strings.js';
import { flag, parseRow, text } from './types.js';
import type { Row } from './types.js';

const FLAG_KEY = /^[a-z][a-z0-9_]{0,99}$/;
/** INT03-F17 1(c): the server refuses to turn this on in R1. The screen says so before the click and still shows the server's answer. */
const NEVER_ON = ['patient_messaging'];

function Flags() {
  const { api } = useConfig();
  const run = usePrivileged();
  const rows = useRows('feature-flags', s.elevateRead);
  const locations = useRows('locations', s.elevateRead);
  const [key, setKey] = useState('');
  const [scope, setScope] = useState('');
  const [enabled, setEnabled] = useState('false');
  const [keyError, setKeyError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const where = (r: Row) => {
    const id = text(r, 'locationId');
    return id === ''
      ? s.anyLocation
      : ((locations.items?.find((l) => text(l, 'id') === id)?.['name'] as string | undefined) ??
          s.none);
  };

  const write = async (body: Row) => {
    setFailure(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const out = await run(
        { action: s.elevateSave, target: s.flags, approver: null },
        () => api.send('PUT', 'feature-flags', body),
        parseRow,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setDone(body['remove'] === true ? s.removed : s.saved);
      await rows.reload();
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (!FLAG_KEY.test(key.trim())) return setKeyError(s.flagKeyInvalid);
    setKeyError(undefined);
    void write({
      key: key.trim(),
      ...(scope === '' ? {} : { locationId: scope }),
      enabled: enabled === 'true',
    });
  };

  return (
    <section aria-labelledby="flags-title">
      <h2 id="flags-title">{s.flags}</h2>
      <ListShell
        state={rows.state}
        items={rows.items}
        reload={() => void rows.reload()}
        more={() => void rows.more()}
      >
        {rows.items?.length === 0 ? (
          <EmptyState message={s.flagsEmpty} />
        ) : (
          <DataTable
            caption={s.flags}
            rows={rows.items ?? []}
            rowKey={(r) => text(r, 'id')}
            columns={[
              { key: 'key', header: s.flagKey, render: (r) => <code>{text(r, 'key')}</code> },
              { key: 'where', header: s.flagScope, render: where },
              {
                key: 'state',
                header: 'State',
                render: (r) => (
                  <StatusChip tone={flag(r, 'enabled') ? 'success' : 'neutral'}>
                    {flag(r, 'enabled') ? s.flagOn : s.flagOff}
                  </StatusChip>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) => {
                  const k = text(r, 'key');
                  const loc = text(r, 'locationId');
                  const ref = { key: k, ...(loc === '' ? {} : { locationId: loc }) };
                  const locked = !flag(r, 'enabled') && NEVER_ON.includes(k);
                  return (
                    <>
                      <Button
                        disabled={busy || locked}
                        aria-label={`${flag(r, 'enabled') ? s.turnOff : s.turnOn}: ${k}, ${where(r)}`}
                        onClick={() => void write({ ...ref, enabled: !flag(r, 'enabled') })}
                      >
                        {flag(r, 'enabled') ? s.turnOff : s.turnOn}
                      </Button>{' '}
                      <Button
                        disabled={busy}
                        aria-label={`${s.remove}: ${k}, ${where(r)}`}
                        onClick={() => void write({ ...ref, remove: true })}
                      >
                        {s.remove}
                      </Button>
                      {locked && <p>{s.messagingLocked}</p>}
                    </>
                  );
                },
              },
            ]}
          />
        )}
      </ListShell>
      <form
        noValidate
        className="ehr-panel"
        aria-labelledby="flag-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3 id="flag-form">{s.setFlag}</h3>
        <ErrorSummary
          title={s.summaryTitle}
          errors={
            keyError === undefined
              ? []
              : [{ fieldId: 'flag-key', message: `${s.flagKey}: ${keyError}` }]
          }
        />
        <TextField
          id="flag-key"
          label={s.flagKey}
          hint={s.flagKeyHint}
          value={key}
          maxLength={100}
          onChange={(e) => setKey(e.target.value)}
          {...(keyError === undefined ? {} : { error: keyError })}
        />
        <SelectField
          id="flag-scope"
          label={s.flagScope}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="">{s.anyLocation}</option>
          {(locations.items ?? []).map((l) => (
            <option key={text(l, 'id')} value={text(l, 'id')}>
              {text(l, 'name')}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="flag-enabled"
          label="State"
          value={enabled}
          onChange={(e) => setEnabled(e.target.value)}
        >
          <option value="false">{s.flagOff}</option>
          <option value="true" disabled={NEVER_ON.includes(key.trim())}>
            {s.flagOn}
          </option>
        </SelectField>
        {NEVER_ON.includes(key.trim()) && <p>{s.messagingLocked}</p>}
        {failure !== undefined && <ActionError failure={failure} />}
        {done !== undefined && (
          <Banner tone="info" announce>
            <p>{done}</p>
          </Banner>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? s.saving : s.save}
        </Button>
      </form>
    </section>
  );
}

/** AD-10: feature flags and banners. */
export function FlagsBanners() {
  return (
    <section aria-labelledby="flagsbanners-title">
      <h1 id="flagsbanners-title">{s.flagsTitle}</h1>
      <p>{s.flagsIntro}</p>
      <p>{s.auditNote}</p>
      <Flags />
      <ResourceScreen spec={BANNERS} />
    </section>
  );
}
