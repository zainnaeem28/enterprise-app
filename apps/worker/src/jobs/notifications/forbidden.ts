// Condition-revealing text (BR-23, BR-36, RA-R1-05, TC-NT-01, TC-NT-06). The render check and the send path scan rendered
// output and values with these rules. A rule NAME is reported, never the matched text. The list is conservative on purpose:
// a false positive makes an administrator reword a template, a false negative leaks a condition. It is not a substitute
// for the structural control (the variable allowlist): it is the second line. `extra` carries the deployment's own terms
// (internal service names, clinician display names) so a template that spells one out is refused too.
// This file is copied byte-for-byte to apps/worker/src/jobs/notifications.
const RULES: readonly (readonly [string, RegExp])[] = [
  ['diagnosis', /\bdiagnos(?:is|es|ed|tic|e)\b/i],
  [
    'medicine',
    /\b(?:medicat\w*|medicine\w*|prescri\w+|drug\w*|tablets?|capsules?|dosage|pharmac\w+|refill\w*|insulin|opioid\w*|methadone|antibiotic\w*|vaccin\w+)\b/i,
  ],
  [
    'test_result',
    /\b(?:test results?|lab(?:oratory)? results?|blood (?:test|work)|biops\w+|screening|scan results?|x-?ray|mri|ct scan|pathology)\b/i,
  ],
  [
    'condition',
    /\b(?:hiv|aids|sti|std|hepatitis|cancer|oncolog\w+|chemo\w*|tumou?rs?|diabet\w+|depress\w+|anxiety|psychiatr\w+|psycholog\w+|mental health|dementia|epilep\w+|asthma|pregnan\w+|abortion|fertility|contracepti\w+|addiction|rehab\w*|substance (?:use|abuse)|sexual health|gender)\b/i,
  ],
  ['clinician_name', /\b(?:Dr|DR|Doctor|Prof|Professor|Nurse|Mr|Mrs|Ms|Miss)\.?\s+[A-Z][a-z]{1,}/],
  [
    'health_word',
    /\b(?:symptoms?|treatment|therapy|condition|illness|disease|disorder|infection|surgery|clinic for)\b/i,
  ],
];

export interface ForbiddenFinding {
  rule: string;
}

export function findForbidden(text: string, extra: readonly string[] = []): ForbiddenFinding[] {
  const found = new Set<string>();
  for (const [rule, re] of RULES) if (re.test(text)) found.add(rule);
  const lower = text.toLowerCase();
  for (const term of extra) {
    const t = term.trim().toLowerCase();
    if (t.length >= 3 && lower.includes(t)) found.add('deployment_term');
  }
  return [...found].map((rule) => ({ rule }));
}

export const FORBIDDEN_RULE_NAMES: readonly string[] = [
  ...RULES.map(([n]) => n),
  'deployment_term',
];
