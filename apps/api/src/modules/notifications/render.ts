// Pure rendering of a template (no I/O). One renderer for every channel, used by the render check (API) and the sending job
// (worker): this file is copied byte-for-byte to apps/worker/src/jobs/notifications and a test compares the two.
// A placeholder is `{{ name }}` and nothing else (the database refuses any other braces). Values come from the allowlist
// only and are validated before they get here; this file escapes them for the channel and never evaluates anything.
import { VARIABLE_ALLOWLIST, isAllowedVariable, type VariableType } from './allowlist.js';

export type Channel = 'email' | 'sms' | 'push' | 'in_app' | 'ics';

export class RenderError extends Error {
  constructor(
    readonly rule: 'missing_variable' | 'undeclared_variable' | 'bad_value' | 'ics_structure',
  ) {
    super(rule);
    this.name = 'RenderError';
  }
}

export interface RenderInput {
  channel: Channel;
  language: string;
  subject: string | null;
  body: string;
  /** Names the template declares (`variables` column). */
  declared: readonly string[];
}

export interface Rendered {
  subject: string | null;
  body: string;
}

const PLACEHOLDER = /\{\{ ?([a-z][a-z0-9_]{0,40}) ?\}\}/g;

function formatDateTime(
  iso: string,
  language: string,
  timeZone: string | undefined,
  channel: Channel,
): string {
  const d = new Date(iso);
  if (channel === 'ics') {
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
  const tz = timeZone ?? 'UTC';
  let lang = language;
  try {
    return (
      new Intl.DateTimeFormat(lang, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: tz,
      }).format(d) + (timeZone === undefined ? ' UTC' : '')
    );
  } catch {
    lang = 'en';
    return (
      new Intl.DateTimeFormat(lang, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: tz,
      }).format(d) + (timeZone === undefined ? ' UTC' : '')
    );
  }
}

const icsEscape = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const oneLine = (v: string): string => v.replace(/[\r\n\u2028\u2029]+/g, ' ');

function substitute(
  text: string,
  input: RenderInput,
  values: Readonly<Record<string, string>>,
  field: 'subject' | 'body',
): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    if (!input.declared.includes(name)) throw new RenderError('undeclared_variable');
    const raw = values[name];
    if (raw === undefined) throw new RenderError('missing_variable');
    const type: VariableType | undefined = VARIABLE_ALLOWLIST[name];
    if (type === undefined || !isAllowedVariable(name, type))
      throw new RenderError('undeclared_variable');
    let out =
      type === 'datetime'
        ? formatDateTime(raw, input.language, values['time_zone'], input.channel)
        : raw;
    if (input.channel === 'ics') out = icsEscape(out);
    else if (field === 'subject' || input.channel === 'sms' || input.channel === 'push')
      out = oneLine(out);
    return out;
  });
}

/** Folds a content line at 75 octets with CRLF + space (RFC 5545 3.1) and ends every line with CRLF. */
function foldIcs(text: string): string {
  const lines = text.split(/\r?\n/).filter((l, i, a) => !(l === '' && i === a.length - 1));
  const out: string[] = [];
  for (const line of lines) {
    let current = '';
    let bytes = 0;
    let limit = 75;
    for (const ch of line) {
      const n = Buffer.byteLength(ch);
      if (bytes + n > limit) {
        out.push(limit === 74 ? ` ${current}` : current);
        current = '';
        bytes = 0;
        limit = 74;
      }
      current += ch;
      bytes += n;
    }
    out.push(limit === 74 ? ` ${current}` : current);
  }
  return out.join('\r\n') + '\r\n';
}

export function renderTemplate(
  input: RenderInput,
  values: Readonly<Record<string, string>>,
): Rendered {
  const subject =
    input.subject === null ? null : substitute(input.subject, input, values, 'subject');
  let body = substitute(input.body, input, values, 'body');
  if (input.channel === 'ics') {
    if (
      !/^BEGIN:VCALENDAR\r?\n/.test(body) ||
      !/END:VCALENDAR\s*$/.test(body) ||
      !/BEGIN:VEVENT/.test(body)
    )
      throw new RenderError('ics_structure');
    body = foldIcs(body);
  }
  return { subject, body };
}

/** Limits that the channel itself imposes (SMS segments, push payload). Checked by the render check. */
export const CHANNEL_LIMITS: Readonly<Record<Channel, number>> = {
  email: 20000,
  sms: 480,
  push: 178,
  in_app: 1000,
  ics: 20000,
};
