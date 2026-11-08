// Shapes the pre-visit screens read. The contract types these bodies as opaque objects (scheduling.yaml, clinical.yaml, patient.yaml),
// so each is checked here and a malformed answer becomes a server-error state. Field names follow apps/api scheduling `previsitFor`,
// clinical frontdoor `QuestionnaireForVisit`/`QuestionnaireResponseView`, patient `CoverageView`/`ConsentView`.
import { asRecord, str } from '../profile/lib/core.js';

export type ItemStatus = 'todo' | 'done' | 'fix';

export const ITEM_LABEL: Record<ItemStatus, string> = {
  todo: 'To do',
  done: 'Done',
  fix: 'Needs fixing',
};

export type ConsentStatus = 'signed' | 'pending' | 'missing' | 'outdated';

/** One required consent. `text` is the template wording; without it the patient cannot read, so cannot sign, here. */
export interface ConsentItem {
  id: string | undefined;
  templateKey: string;
  title: string;
  text: string | undefined;
  status: ConsentStatus;
}

export interface Previsit {
  reservationId: string;
  questionnaire: boolean;
  consents: boolean;
  insurance: boolean;
  /** Present only if the API lists the required consents (the implemented route returns the three flags only). */
  consentItems: ConsentItem[] | undefined;
  /** The API accepts the open-consents POST only while the visit is confirmed or checked in; otherwise it answers 404. */
  canOpenConsents: boolean;
}

const STATUSES: readonly string[] = ['signed', 'pending', 'missing', 'outdated'];

export function parseConsent(v: unknown): ConsentItem | undefined {
  const o = asRecord(v);
  const key = str(o['templateKey']) ?? str(o['key']);
  const status = str(o['status']);
  if (key === undefined || status === undefined || !STATUSES.includes(status)) return undefined;
  return {
    id: str(o['id']) ?? str(o['consentId']),
    templateKey: key,
    title: str(o['title']) ?? str(o['name']) ?? key,
    text: str(o['text']) ?? str(o['body']),
    status: status as ConsentStatus,
  };
}

export function parsePrevisit(d: unknown): Previsit | undefined {
  const o = asRecord(d);
  const id = str(o['reservationId']);
  if (
    id === undefined ||
    typeof o['questionnaire'] !== 'boolean' ||
    typeof o['consents'] !== 'boolean' ||
    typeof o['insurance'] !== 'boolean'
  )
    return undefined;
  let consentItems: ConsentItem[] | undefined;
  if (Array.isArray(o['requiredConsents'])) {
    const items = o['requiredConsents'].map(parseConsent);
    if (items.every((i) => i !== undefined)) consentItems = items as ConsentItem[];
  }
  return {
    reservationId: id,
    questionnaire: o['questionnaire'],
    consents: o['consents'],
    insurance: o['insurance'],
    consentItems,
    canOpenConsents: o['canOpenConsents'] === true,
  };
}

export type QuestionKind = 'text' | 'yesno' | 'choice' | 'number';

export interface Question {
  id: string;
  label: string;
  kind: QuestionKind;
  options: { value: string; label: string }[];
  required: boolean;
}

export interface Template {
  key: string;
  version: number;
  title: string;
  questions: Question[];
}

export type Answer = string | boolean | number;

export interface QResponse {
  id: string;
  answers: Record<string, Answer>;
  status: 'in_progress' | 'submitted';
  redFlag: boolean;
  version: number;
}

export interface QuestionnaireForVisit {
  template: Template | null;
  response: QResponse | null;
}

function parseQuestion(v: unknown): Question | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const label = str(o['label']) ?? str(o['text']) ?? str(o['prompt']);
  if (id === undefined || label === undefined) return undefined;
  const t = str(o['type']) ?? str(o['kind']);
  const options = (Array.isArray(o['options']) ? o['options'] : [])
    .map((x) => (typeof x === 'string' ? { value: x, label: x } : asRecord(x)))
    .map((x) => ({ value: str(x['value']) ?? '', label: str(x['label']) ?? str(x['value']) ?? '' }))
    .filter((x) => x.value !== '');
  const kind: QuestionKind =
    t === 'boolean' || t === 'yesno' || t === 'yes_no'
      ? 'yesno'
      : t === 'number'
        ? 'number'
        : t === 'choice' || t === 'select' || options.length > 0
          ? 'choice'
          : 'text';
  // A question is required unless the template says otherwise: a rule question left blank is never read as "no" (BE-18).
  return { id, label, kind, options, required: o['required'] !== false };
}

export function parseTemplate(v: unknown): Template | null | undefined {
  if (v === null) return null;
  const o = asRecord(v);
  const key = str(o['key']);
  const version = typeof o['version'] === 'number' ? o['version'] : undefined;
  const qs = asRecord(o['schema'])['questions'];
  if (key === undefined || version === undefined || !Array.isArray(qs)) return undefined;
  const questions = qs.map(parseQuestion);
  if (questions.some((q) => q === undefined)) return undefined;
  return {
    key,
    version,
    title: str(asRecord(o['schema'])['title']) ?? 'Health questionnaire',
    questions: questions as Question[],
  };
}

export function parseResponse(v: unknown, etagVersion?: number): QResponse | null | undefined {
  if (v === null) return null;
  const o = asRecord(v);
  const id = str(o['id']);
  const version = typeof o['version'] === 'number' ? o['version'] : etagVersion;
  if (id === undefined || version === undefined) return undefined;
  const answers: Record<string, Answer> = {};
  for (const [k, a] of Object.entries(asRecord(o['answers'])))
    if (typeof a === 'string' || typeof a === 'boolean' || typeof a === 'number') answers[k] = a;
  return {
    id,
    answers,
    status: o['status'] === 'submitted' ? 'submitted' : 'in_progress',
    redFlag: o['redFlag'] === true,
    version,
  };
}

export function parseForVisit(d: unknown, etagVersion?: number): QuestionnaireForVisit | undefined {
  const o = asRecord(d);
  const template = parseTemplate(o['template'] ?? null);
  const response = parseResponse(o['response'] ?? null, etagVersion);
  return template === undefined || response === undefined ? undefined : { template, response };
}

export interface SubmitResult {
  redFlag: boolean;
  advice: string | undefined;
  response: QResponse;
}

export function parseSubmit(d: unknown, etagVersion?: number): SubmitResult | undefined {
  const o = asRecord(d);
  const response = parseResponse(o['response'], etagVersion);
  if (response === undefined || response === null) return undefined;
  const adviceRaw = o['advice'];
  const advice =
    typeof adviceRaw === 'string'
      ? adviceRaw
      : (str(asRecord(adviceRaw)['text']) ?? str(asRecord(adviceRaw)['message']));
  return { redFlag: o['redFlag'] === true, advice, response };
}

export interface Coverage {
  id: string;
  payerName: string;
  memberId: string;
  groupNumber: string;
  frontDocumentId: string | null;
  backDocumentId: string | null;
  active: boolean;
  version: number;
}

export function parseCoverage(v: unknown): Coverage | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const version = typeof o['rowVersion'] === 'number' ? o['rowVersion'] : undefined;
  if (id === undefined || version === undefined) return undefined;
  return {
    id,
    payerName: str(o['payerName']) ?? '',
    memberId: str(o['memberId']) ?? '',
    groupNumber: str(o['groupNumber']) ?? '',
    frontDocumentId: str(o['frontDocumentId']) ?? null,
    backDocumentId: str(o['backDocumentId']) ?? null,
    active: o['active'] !== false,
    version,
  };
}

export function parseList<T>(d: unknown, one: (v: unknown) => T | undefined): T[] | undefined {
  const items = asRecord(d)['items'];
  if (!Array.isArray(items)) return undefined;
  const out = items.map(one);
  return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
}
