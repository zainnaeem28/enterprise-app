import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  SelectField,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { Column, FieldError } from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { useConfig, usePrivileged, useRows } from './hooks.js';
import { ActionError, ListShell } from './Problem.js';
import { configStrings as s } from './strings.js';
import { keyOf, parseRow, text, version } from './types.js';
import type { Row } from './types.js';

export interface Option {
  value: string;
  label: string;
}
export type FieldType =
  'text' | 'textarea' | 'json' | 'int' | 'bool' | 'select' | 'time' | 'date' | 'datetime';
export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  /** Fixed choices, or choices that depend on the values the form started with (a stored value may need its own choice). */
  options?: Option[] | ((start: Values) => Option[]);
  /** A select whose value is sent as a number. */
  asNumber?: boolean;
  /** Options come from the rows of another list: its path, the label column, and the label of the empty choice. */
  ref?: { path: string; label: string; empty?: string };
  /** Set when the row is created, never changed afterwards (the server refuses a change). */
  createOnly?: boolean;
  /** An emptied value is sent as `null` when changing a row. */
  nullable?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  def?: string | boolean;
  /** Returns a message when the value is not acceptable. */
  check?: (value: string, all: Values) => string | undefined;
}
export type Values = Record<string, string | boolean>;

export interface ResourceSpec {
  /** Collection path under /api/v1/admin. */
  path: string;
  /** Heading of the section and the table caption. */
  title: string;
  empty: string;
  fields: Field[];
  /** `PATCH` changes with `If-Match`; `PUT` upserts by the identity in the body. */
  change: 'PATCH' | 'PUT';
  columns: (refs: Record<string, Option[]>) => Column<Row>[];
  rowLabel: (row: Row, refs: Record<string, Option[]>) => string;
  /** The body keys that name the row on change and removal. Default `{id}`. */
  identity?: (row: Row) => Row;
  /** Removal is a body flag on the same route (the contract has no DELETE). */
  removable?: boolean;
  /** A rule across fields. Returns messages by field name. */
  validate?: (v: Values) => Record<string, string> | undefined;
  /** Extra content under the form fields (previews, notes). */
  aside?: (v: Values) => ReactNode;
  query?: Record<string, string>;
  /** Rows cannot be changed, only added (versioned templates). */
  noEdit?: boolean;
  /** An action beside a row's Edit button; `reload` re-reads the list. */
  rowAction?: (row: Row, reload: () => Promise<void>) => ReactNode;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtTime = (iso: string | null | undefined): string => {
  if (iso === null || iso === undefined) return s.none;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? s.none
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function initial(fields: Field[], row?: Row): Values {
  const v: Values = {};
  for (const f of fields) {
    const raw = row?.[f.name];
    if (row === undefined) v[f.name] = f.def ?? (f.type === 'bool' ? false : '');
    else if (f.type === 'bool') v[f.name] = raw === true;
    else if (f.type === 'datetime') v[f.name] = typeof raw === 'string' ? toLocalInput(raw) : '';
    else v[f.name] = raw === null || raw === undefined ? '' : String(raw as string | number);
  }
  return v;
}

function valueOf(f: Field, v: string | boolean): unknown {
  if (f.type === 'bool') return v === true;
  const t = typeof v === 'string' ? v.trim() : '';
  if (f.type === 'int') return Number(t);
  if (f.type === 'datetime') return new Date(t).toISOString();
  if (f.type === 'json') return JSON.parse(t) as unknown;
  if (f.type === 'select' && f.asNumber === true) return Number(t);
  if (f.type === 'time') return t.slice(0, 5);
  return t;
}

function isJsonObject(t: string): boolean {
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

function check(spec: ResourceSpec, v: Values, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of spec.fields) {
    if (editing && f.createOnly === true) continue;
    const raw = v[f.name];
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (f.type !== 'bool' && t === '') {
      if (f.required === true) errors[f.name] = s.required;
      continue;
    }
    if (f.type === 'int') {
      if (!/^-?\d+$/.test(t)) errors[f.name] = s.mustBeNumber;
      else if (
        (f.min !== undefined && Number(t) < f.min) ||
        (f.max !== undefined && Number(t) > f.max)
      )
        errors[f.name] = s.outOfRange(f.min ?? 0, f.max ?? 1_000_000_000);
    } else if (f.type === 'datetime' && Number.isNaN(new Date(t).getTime()))
      errors[f.name] = s.invalid;
    else if (f.type === 'json' && !isJsonObject(t)) errors[f.name] = s.schemaInvalid;
    else if (f.check !== undefined) {
      const m = f.check(t, v);
      if (m !== undefined) errors[f.name] = m;
    }
  }
  return { ...errors, ...(spec.validate?.(v) ?? {}) };
}

/** The server named the fields it refused; show them as field errors without echoing any value. */
const serverErrors = (f: Failure, spec: ResourceSpec): Record<string, string> =>
  f.code === 'kernel.validation_failed' || f.code === 'organisation.neutral_name_required'
    ? Object.fromEntries(
        f.fields
          .map((p) => p.split('/')[0] ?? p)
          .filter((p) => spec.fields.some((x) => x.name === p))
          .map((p) => [p, s.invalid]),
      )
    : {};

/**
 * A list of one configuration resource with an add / change / remove form. Every call needs the elevation grant (the dialog opens
 * when it is missing) and is audited by the server. A write that is refused keeps what was typed.
 */
export function ResourceScreen({
  spec,
  headingLevel = 2,
}: {
  spec: ResourceSpec;
  headingLevel?: 2 | 3;
}) {
  const { api } = useConfig();
  const run = usePrivileged();
  const rows = useRows(spec.path, s.elevateRead, spec.query);
  const refPaths = [
    ...new Set(spec.fields.flatMap((f) => (f.ref === undefined ? [] : [f.ref.path]))),
  ];
  const refs = useRefs(refPaths, spec.fields);
  const [editing, setEditing] = useState<Row | 'new' | undefined>();
  const [values, setValues] = useState<Values>({});
  const [start, setStart] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  const H = headingLevel === 2 ? 'h2' : 'h3';
  const Sub = headingLevel === 2 ? 'h3' : 'h4';
  const id = `res-${spec.path}`;
  const identity = spec.identity ?? ((r: Row) => ({ id: r['id'] }));
  const isNew = editing === 'new';
  const row = editing !== undefined && editing !== 'new' ? editing : undefined;

  const open = (target: Row | 'new') => {
    setEditing(target);
    const init = initial(spec.fields, target === 'new' ? undefined : target);
    setValues(init);
    setStart(init);
    setErrors({});
    setFailure(undefined);
    setDone(undefined);
    setConfirming(false);
  };
  const close = () => {
    setEditing(undefined);
    setConfirming(false);
  };
  const fieldErrors: FieldError[] = spec.fields
    .filter((f) => errors[f.name] !== undefined)
    .map((f) => ({
      fieldId: `${id}-field-${f.name}`,
      message: `${f.label}: ${errors[f.name] ?? ''}`,
    }));

  const submit = async () => {
    const found = check(spec, values, row !== undefined);
    setErrors(found);
    setFailure(undefined);
    setDone(undefined);
    if (Object.keys(found).length > 0) return;
    let body: Row;
    if (row === undefined) {
      body = {};
      for (const f of spec.fields) {
        const raw = values[f.name];
        if (f.type !== 'bool' && (typeof raw !== 'string' || raw.trim() === '')) continue;
        body[f.name] = valueOf(f, raw ?? '');
      }
    } else {
      body = { ...identity(row) };
      let changed = false;
      for (const f of spec.fields) {
        if (f.createOnly === true || values[f.name] === start[f.name]) continue;
        const raw = values[f.name];
        const empty = f.type !== 'bool' && (typeof raw !== 'string' || raw.trim() === '');
        if (empty && f.nullable !== true) continue;
        body[f.name] = empty ? null : valueOf(f, raw ?? '');
        changed = true;
      }
      if (!changed) return setDone(s.nothingChanged);
    }
    const method = row === undefined ? (spec.change === 'PUT' ? 'PUT' : 'POST') : spec.change;
    setBusy(true);
    try {
      const out = await run(
        { action: s.elevateSave, target: spec.title, approver: null },
        () =>
          api.send(
            method,
            spec.path,
            body,
            spec.change === 'PATCH' && row !== undefined ? version(row) : undefined,
          ),
        parseRow,
      );
      if (out === undefined) return; // the key dialog was cancelled: keep what was typed
      if (!out.ok) {
        setErrors(serverErrors(out, spec));
        if (out.status === 412) void rows.reload();
        return setFailure(out);
      }
      setDone(s.saved);
      setEditing(undefined);
      await rows.reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (row === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const out = await run(
        { action: s.elevateSave, target: spec.title, approver: null },
        () =>
          api.send(
            spec.change,
            spec.path,
            { ...identity(row), remove: true },
            spec.change === 'PATCH' ? version(row) : undefined,
          ),
        parseRow,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setConfirming(false);
      setEditing(undefined);
      setDone(s.removed);
      await rows.reload();
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo(() => spec.columns(refs.options), [spec, refs.options]);
  const items = rows.items;
  const noRef = spec.fields.find(
    (f) =>
      f.ref !== undefined &&
      f.required === true &&
      (refs.options[f.ref.path] ?? []).length === 0 &&
      refs.loaded,
  );

  return (
    <section aria-labelledby={`${id}-title`}>
      <H id={`${id}-title`}>{spec.title}</H>
      <ListShell
        state={rows.state}
        items={items}
        reload={() => void rows.reload()}
        more={() => void rows.more()}
      >
        {items !== undefined && items.length === 0 ? (
          <EmptyState message={spec.empty} />
        ) : (
          <DataTable
            caption={spec.title}
            rows={items ?? []}
            rowKey={keyOf}
            columns={[
              ...columns,
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <>
                    {spec.noEdit !== true && (
                      <Button
                        aria-label={`${s.edit}: ${spec.rowLabel(r, refs.options)}`}
                        onClick={() => open(r)}
                      >
                        {s.edit}
                      </Button>
                    )}
                    {spec.rowAction?.(r, rows.reload)}
                  </>
                ),
              },
            ]}
          />
        )}
      </ListShell>
      {done !== undefined && editing === undefined && (
        <Banner tone="info" announce>
          <p>{done}</p>
        </Banner>
      )}
      {editing === undefined ? (
        <p>
          <Button
            variant="primary"
            disabled={noRef !== undefined}
            onClick={() => open('new')}
            aria-label={`${s.add}: ${spec.title}`}
          >
            {s.add}
          </Button>
          {noRef?.ref !== undefined &&
            ` ${noRef.ref.path === 'services' ? s.needService : s.needLocation}`}
        </p>
      ) : (
        <form
          noValidate
          className="ehr-panel"
          aria-labelledby={`${id}-form`}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Sub id={`${id}-form`}>{`${isNew ? s.add : s.edit}: ${spec.title}`}</Sub>
          <ErrorSummary title={s.summaryTitle} errors={fieldErrors} />
          {spec.fields.map((f) => {
            if (!isNew && f.createOnly === true) return null;
            const common = {
              id: `${id}-field-${f.name}`,
              label: f.label,
              ...(f.hint === undefined ? {} : { hint: f.hint }),
              ...(errors[f.name] === undefined ? {} : { error: errors[f.name] }),
            };
            const val = values[f.name];
            const set = (x: string | boolean) => setValues((p) => ({ ...p, [f.name]: x }));
            if (f.type === 'bool')
              return (
                <div key={f.name} className="ehr-check">
                  <input
                    type="checkbox"
                    id={common.id}
                    checked={val === true}
                    onChange={(e) => set(e.target.checked)}
                  />{' '}
                  <label htmlFor={common.id}>{f.label}</label>
                </div>
              );
            if (f.type === 'select' || f.ref !== undefined) {
              const fixed = typeof f.options === 'function' ? f.options(start) : (f.options ?? []);
              const opts = f.ref === undefined ? fixed : (refs.options[f.ref.path] ?? []);
              return (
                <SelectField
                  key={f.name}
                  {...common}
                  value={String(val)}
                  onChange={(e) => set(e.target.value)}
                >
                  {(f.required !== true || f.ref?.empty !== undefined) && (
                    <option value="">{f.ref?.empty ?? s.none}</option>
                  )}
                  {f.required === true && f.ref?.empty === undefined && val === '' && (
                    <option value="" disabled>
                      {s.none}
                    </option>
                  )}
                  {opts.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </SelectField>
              );
            }
            if (f.type === 'textarea' || f.type === 'json')
              return (
                <TextAreaField
                  key={f.name}
                  {...common}
                  value={String(val)}
                  {...(f.maxLength === undefined ? {} : { maxLength: f.maxLength })}
                  onChange={(e) => set(e.target.value)}
                />
              );
            const htmlType = {
              text: 'text',
              int: 'text',
              time: 'time',
              date: 'date',
              datetime: 'datetime-local',
            }[f.type];
            return (
              <TextField
                key={f.name}
                {...common}
                type={htmlType}
                {...(f.type === 'int' ? { inputMode: 'numeric' as const } : {})}
                value={String(val)}
                {...(f.maxLength === undefined ? {} : { maxLength: f.maxLength })}
                onChange={(e) => set(e.target.value)}
              />
            );
          })}
          {spec.aside?.(values)}
          {failure !== undefined && <ActionError failure={failure} />}
          {confirming && row !== undefined ? (
            <Banner tone="warning">
              <p>{`${s.remove}: ${spec.rowLabel(row, refs.options)}?`}</p>
              <Button variant="primary" disabled={busy} onClick={() => void remove()}>
                {`${s.remove}`}
              </Button>{' '}
              <Button onClick={() => setConfirming(false)}>{s.cancel}</Button>
            </Banner>
          ) : (
            <p>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? s.saving : s.save}
              </Button>{' '}
              <Button onClick={close}>{s.cancel}</Button>
              {spec.removable === true && row !== undefined && (
                <>
                  {' '}
                  <Button disabled={busy} onClick={() => setConfirming(true)}>
                    {s.remove}
                  </Button>
                </>
              )}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

/** Option lists for the select fields that point at another resource (locations, services). */
function useRefs(paths: string[], fields: Field[]) {
  const loc = useRows(paths.includes('locations') ? 'locations' : undefined, s.elevateRead);
  const svc = useRows(paths.includes('services') ? 'services' : undefined, s.elevateRead);
  const label = (path: string) => fields.find((f) => f.ref?.path === path)?.ref?.label ?? 'name';
  const make = (items: Row[] | undefined, path: string): Option[] =>
    (items ?? []).map((r) => ({ value: text(r, 'id'), label: text(r, label(path)) }));
  const options: Record<string, Option[]> = {
    locations: make(loc.items, 'locations'),
    services: make(svc.items, 'services'),
  };
  const loaded =
    (!paths.includes('locations') || loc.state.kind === 'ok') &&
    (!paths.includes('services') || svc.state.kind === 'ok');
  return { options, loaded };
}
