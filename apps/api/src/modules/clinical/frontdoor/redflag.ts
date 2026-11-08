// Red-flag rule evaluation (ARCHITECTURE 25.5, BR-10, AC-08). A MECHANISM only: the rules are data on the published questionnaire
// template (`schema.red_flag_rules`, with the D-12a reviewer's note recorded on publish, 22.11), and nothing in this file names a
// symptom, an answer or a threshold. What counts as a red flag is the safety reviewer's decision (RA-R1-07 stays blocked until
// D-12a); this code only compares an answer with a rule exactly.
//
// A rule: `{ question, equals | in | contains | gt | gte | lt | lte }`, one comparison. An answer is compared exactly (strings
// trimmed, case kept; numbers as numbers; booleans as booleans): a near-miss never matches (TC-SAF-03). `contains` is for an answer
// that is a list (multiple choice). A rule that cannot be read (no question, no or several operators, a value of the wrong type)
// FAILS TOWARD SAFETY: it counts as a match and is reported, so a broken rule raises alerts instead of silently raising none.
//
// A question that a rule reads and the answers do not hold (absent, null or blank) is reported in `unanswered`: the caller refuses
// the request. Blank is never "no red flag" (TC-SAF-03 step 3).

export interface RedFlagResult {
  /** True when any rule matched, or any rule could not be read. */
  redFlag: boolean;
  matchedQuestions: string[];
  /** Rule questions with no usable answer. */
  unanswered: string[];
  /** Rules that could not be read (each counted as a match). */
  invalidRules: number;
}

type Json = unknown;
const OPS = ['equals', 'in', 'contains', 'gt', 'gte', 'lt', 'lte'] as const;

const isBlank = (v: Json): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

const norm = (v: Json): Json => (typeof v === 'string' ? v.trim() : v);
const same = (a: Json, b: Json): boolean => norm(a) === norm(b);

function rulesOf(schema: Record<string, unknown>): Json[] {
  const r = schema['red_flag_rules'];
  return Array.isArray(r) ? (r as Json[]) : [];
}

/** The template's emergency advice text (BR-10), or undefined when the template has none. */
export function adviceOf(schema: Record<string, unknown>): string | undefined {
  const a = schema['emergency_advice'];
  return typeof a === 'string' && a.trim() !== '' ? a : undefined;
}

/** The question IDs the rules read (for the "required answer" check, and for the response form). */
export function ruleQuestions(schema: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const r of rulesOf(schema))
    if (
      r !== null &&
      typeof r === 'object' &&
      typeof (r as Record<string, unknown>)['question'] === 'string'
    )
      out.add((r as Record<string, string>)['question'] as string);
  return [...out];
}

export function evaluateRedFlags(
  schema: Record<string, unknown>,
  answers: Record<string, unknown>,
): RedFlagResult {
  const matched = new Set<string>();
  const unanswered = new Set<string>();
  let invalid = 0;
  for (const rule of rulesOf(schema)) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      invalid++;
      continue;
    }
    const r = rule as Record<string, Json>;
    const q = r['question'];
    const ops = OPS.filter((o) => r[o] !== undefined);
    if (typeof q !== 'string' || q === '' || ops.length !== 1) {
      invalid++;
      continue;
    }
    const answer = answers[q];
    if (isBlank(answer)) {
      unanswered.add(q);
      continue;
    }
    const op = ops[0] as (typeof OPS)[number];
    const want = r[op];
    let hit: boolean | null;
    switch (op) {
      case 'equals':
        hit = Array.isArray(answer) ? null : same(answer, want);
        break;
      case 'in':
        hit =
          Array.isArray(want) && !Array.isArray(answer) ? want.some((w) => same(answer, w)) : null;
        break;
      case 'contains':
        hit = Array.isArray(answer) ? answer.some((a) => same(a, want)) : null;
        break;
      default:
        hit =
          typeof answer === 'number' &&
          typeof want === 'number' &&
          Number.isFinite(answer) &&
          Number.isFinite(want)
            ? op === 'gt'
              ? answer > want
              : op === 'gte'
                ? answer >= want
                : op === 'lt'
                  ? answer < want
                  : answer <= want
            : null;
    }
    if (hit === null) invalid++;
    else if (hit) matched.add(q);
  }
  return {
    redFlag: matched.size > 0 || invalid > 0,
    matchedQuestions: [...matched].sort(),
    unanswered: [...unanswered].sort(),
    invalidRules: invalid,
  };
}
