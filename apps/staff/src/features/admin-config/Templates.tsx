import { useState } from 'react';
import { Banner, Button, StatusChip, TextAreaField } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { useConfig, usePrivileged } from './hooks.js';
import { ActionError } from './Problem.js';
import { ResourceScreen } from './ResourceScreen.js';
import type { ResourceSpec } from './ResourceScreen.js';
import { configStrings as s } from './strings.js';
import { parseRow, text } from './types.js';
import type { Row } from './types.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const keyField = {
  name: 'key',
  label: 'Template key',
  type: 'text' as const,
  required: true,
  maxLength: 100,
  hint: 'Letters, digits, “.”, “_” and “-”.',
  check: (v: string) => (KEY.test(v) ? undefined : s.invalid),
};
const statusChip = (r: Row) => {
  const st = text(r, 'status');
  return (
    <StatusChip tone={st === 'published' ? 'success' : st === 'draft' ? 'info' : 'neutral'}>
      {st === 'published' ? s.published : st === 'draft' ? s.draft : s.retired}
    </StatusChip>
  );
};

/** Red-flag rules in a questionnaire's definition need the safety reviewer's note to publish (BR-10, D-12a). */
const ruleCount = (r: Row): number => {
  const schema = r['schema'];
  const rules =
    typeof schema === 'object' && schema !== null
      ? (schema as Record<string, unknown>)['red_flag_rules']
      : undefined;
  return Array.isArray(rules) ? rules.length : 0;
};

function PublishButton({
  kind,
  row,
  reload,
}: {
  kind: 'consent' | 'questionnaire';
  row: Row;
  reload: () => Promise<void>;
}) {
  const { api } = useConfig();
  const run = usePrivileged();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState(false);
  const needsNote = kind === 'questionnaire' && ruleCount(row) > 0;
  const name = `${text(row, 'key')} version ${String(row['version'] ?? '')}`;
  if (text(row, 'status') !== 'draft') return null;

  const publish = async () => {
    if (needsNote && note.trim().length < 10) return setNoteError(s.reviewerNoteShort);
    setNoteError(undefined);
    setFailure(undefined);
    setBusy(true);
    try {
      const out = await run(
        { action: `Publish ${name}`, target: name, approver: null },
        () =>
          api.publish(
            kind,
            text(row, 'id'),
            needsNote || note.trim() !== '' ? { approvedByNote: note.trim() } : {},
          ),
        parseRow,
      );
      if (out === undefined) return;
      if (!out.ok) {
        setFailure(out);
        if (out.status === 412) await reload();
        return;
      }
      setDone(true);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <Button aria-label={`${s.publish}: ${name}`} onClick={() => setOpen(true)}>
        {s.publish}
      </Button>
    );
  return (
    <div className="ehr-panel" role="group" aria-label={`${s.publish}: ${name}`}>
      {needsNote && (
        <TextAreaField
          id={`note-${text(row, 'id')}`}
          label={s.reviewerNote}
          hint={s.reviewerNoteHint}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          {...(noteError === undefined ? {} : { error: noteError })}
        />
      )}
      {failure !== undefined && <ActionError failure={failure} />}
      {done && (
        <Banner tone="info" announce>
          <p>{s.publishedNow}</p>
        </Banner>
      )}
      <Button variant="primary" disabled={busy} onClick={() => void publish()}>
        {busy ? s.saving : `${s.publish} ${name}`}
      </Button>{' '}
      <Button onClick={() => setOpen(false)}>{s.cancel}</Button>
    </div>
  );
}

const common = (kind: 'consent' | 'questionnaire') => ({
  change: 'PATCH' as const,
  noEdit: true,
  empty: s.templatesEmpty,
  rowAction: (row: Row, reload: () => Promise<void>) => (
    <PublishButton kind={kind} row={row} reload={reload} />
  ),
});

export const CONSENT: ResourceSpec = {
  ...common('consent'),
  path: 'consent-templates',
  title: s.consent,
  fields: [
    keyField,
    {
      name: 'language',
      label: 'Language',
      type: 'text',
      required: true,
      hint: 'For example en or es.',
      maxLength: 35,
      check: (v) => (v.length >= 2 ? undefined : s.invalid),
    },
    {
      name: 'bodyDocumentId',
      label: s.bodyDocument,
      type: 'text',
      required: true,
      hint: s.bodyDocumentHint,
      check: (v) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
          ? undefined
          : s.invalid,
    },
  ],
  columns: () => [
    { key: 'key', header: 'Key', render: (r) => text(r, 'key') },
    { key: 'ver', header: 'Version', render: (r) => String(r['version'] ?? s.none) },
    { key: 'lang', header: 'Language', render: (r) => text(r, 'language') },
    { key: 'status', header: 'State', render: statusChip },
  ],
  rowLabel: (r) => `${text(r, 'key')} ${String(r['version'] ?? '')}`,
};

export const QUESTIONNAIRE: ResourceSpec = {
  ...common('questionnaire'),
  path: 'questionnaire-templates',
  title: s.questionnaires,
  fields: [
    keyField,
    { name: 'schema', label: s.schemaLabel, type: 'json', required: true, maxLength: 20000 },
  ],
  columns: () => [
    { key: 'key', header: 'Key', render: (r) => text(r, 'key') },
    { key: 'ver', header: 'Version', render: (r) => String(r['version'] ?? s.none) },
    { key: 'rules', header: 'Red-flag rules', render: (r) => String(ruleCount(r)) },
    { key: 'status', header: 'State', render: statusChip },
  ],
  rowLabel: (r) => `${text(r, 'key')} ${String(r['version'] ?? '')}`,
};

/** AD-08: consent and questionnaire templates (versioned: a new version is a draft until published). */
export function Templates() {
  return (
    <section aria-labelledby="templates-title">
      <h1 id="templates-title">{s.templatesTitle}</h1>
      <p>{s.templatesIntro}</p>
      <p>{s.messageTemplatesNote}</p>
      <ResourceScreen spec={CONSENT} />
      <ResourceScreen spec={QUESTIONNAIRE} />
    </section>
  );
}
