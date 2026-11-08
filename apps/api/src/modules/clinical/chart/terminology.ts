// `clinical.terminologySearch` and the lookup behind coded entries (ARCHITECTURE 22.11, 24, 29.3). The concepts are reference data
// (C0) loaded by the worker job `clinical.terminology_load`; real RxNorm / SNOMED CT / ICD-10-CM / LOINC content needs the NLM/UMLS
// licence account (C-09), so until it is loaded the picker is empty and every entry is free text, flagged uncoded (RA-R1-09).
import type { Tx } from '@ehr/kernel';
import { ChartValidationError } from './errors.js';
import { TERMINOLOGY_SYSTEMS } from './types.js';
import type { CodeSystem, Concept } from './types.js';

export const SEARCH_LIMIT = 20;
const MIN_TEXT = 2;
const MAX_TEXT = 100;

type Row = Record<string, unknown>;

const isSystem = (v: unknown): v is CodeSystem =>
  typeof v === 'string' && (TERMINOLOGY_SYSTEMS as readonly string[]).includes(v);

const conceptOf = (r: Row): Concept => ({
  system: r['system'] as CodeSystem,
  code: String(r['code']),
  display: String(r['display']),
});

/** Escapes LIKE metacharacters so the text is matched literally. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class TerminologyService {
  /** `POST /terminology/search`: at most 20 active concepts of one system; a code match first, then a display that starts with the text. */
  async search(tx: Tx, input: { system: unknown; text: unknown }): Promise<Concept[]> {
    const bad: string[] = [];
    if (!isSystem(input.system)) bad.push('system');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length < MIN_TEXT || text.length > MAX_TEXT) bad.push('text');
    if (bad.length > 0) throw new ChartValidationError(bad);
    const esc = likeEscape(text);
    const r = await tx.query(
      `SELECT system, code, display FROM clinical.terminology_concept
        WHERE system = $1 AND active AND (display ILIKE $2 ESCAPE '\\' OR lower(code) = lower($3))
        ORDER BY (lower(code) = lower($3)) DESC, (display ILIKE $4 ESCAPE '\\') DESC, char_length(display), display, code
        LIMIT ${SEARCH_LIMIT}`,
      [input.system, `%${esc}%`, text, `${esc}%`],
    );
    return (r.rows as Row[]).map(conceptOf);
  }

  /** The active concept for a code a client chose from the picker, or undefined (inactive, unknown, or another system). */
  async find(tx: Tx, system: string, code: string): Promise<Concept | undefined> {
    if (!isSystem(system)) return undefined;
    const r = await tx.query(
      `SELECT system, code, display FROM clinical.terminology_concept WHERE system = $1 AND code = $2 AND active`,
      [system, code],
    );
    return r.rows[0] === undefined ? undefined : conceptOf(r.rows[0] as Row);
  }
}
