// The note templates of R1 (ARCHITECTURE 22.11 `note.template_id`, PRD RA-R1-09: "basic clinical notes", UI-UX Desktop 4 "SOAP editor").
// 22.11 gives the note a template_id and no template table, so the list is code: one built-in SOAP template. A later release that
// lets an administrator define templates adds a table and keeps these keys valid. The template fixes the section keys; the text in
// them is the clinician's. Nothing here is clinical content.
import { NotesValidationError } from './errors.js';
import type { NoteSections } from './types.js';

export interface NoteTemplate {
  id: string;
  /** Section keys in display order. */
  sections: readonly string[];
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { id: 'soap', sections: ['subjective', 'objective', 'assessment', 'plan'] },
];

export const DEFAULT_TEMPLATE = 'soap';
export const MAX_SECTION_CHARS = 50_000;
/** Serialised size bound of a note body (22.11: <= 200 KB; the column CHECK is the same bound). */
export const MAX_BODY_BYTES = 200_000;

export function templateOf(id: unknown): NoteTemplate {
  const t = NOTE_TEMPLATES.find((x) => x.id === id);
  if (t === undefined) throw new NotesValidationError(['templateId'], 'clinical.unknown_template');
  return t;
}

/** An empty body for a template: every section present and empty. */
export function emptyBody(t: NoteTemplate): { sections: NoteSections } {
  return { sections: Object.fromEntries(t.sections.map((s) => [s, ''])) };
}

/**
 * Applies the sections of a save to the stored ones (only the sections named are replaced). Unknown keys, non-strings and over-long
 * text are refused; nothing partial is applied.
 */
export function applySections(
  t: NoteTemplate,
  current: unknown,
  incoming: unknown,
): { sections: NoteSections } {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming))
    throw new NotesValidationError(['sections']);
  const bad: string[] = [];
  const base: NoteSections = {};
  const cur = (current as { sections?: unknown } | null)?.sections;
  for (const s of t.sections) {
    const v = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[s] : '';
    base[s] = typeof v === 'string' ? v : '';
  }
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (!t.sections.includes(k)) bad.push(`sections/${k}`);
    else if (typeof v !== 'string' || v.length > MAX_SECTION_CHARS) bad.push(`sections/${k}`);
    else base[k] = v;
  }
  if (bad.length > 0) throw new NotesValidationError(bad);
  const body = { sections: base };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES)
    throw new NotesValidationError(['sections'], 'kernel.too_large');
  return body;
}
