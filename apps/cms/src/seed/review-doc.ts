import { SEED_VERSION, seededStrings } from './copy';

// Keys whose wording states a fact about the law, an emergency number or how the site behaves: counsel confirms before go-live (†).
const COUNSEL = /^legal\.|contact\.intro$/;

/** Medical-claim screen applied to every seeded string (also asserted by a test). */
export const CLAIM_TERMS =
  /\b(cure[sd]?|curing|treat(s|ed|ing|ment|ments)?|heal(s|ed|ing)?|diagnos\w*|guarantee\w*|best|leading|top[- ]rated|proven|effective\w*|expert\w*|specialis\w*|outcomes?|prevent\w*|therap\w*|safe(ly|st)?|painless|clinically)\b/i;

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ');

export function renderReviewDoc(): string {
  const rows = seededStrings().map(({ key, text }) => {
    const flag = COUNSEL.test(key) ? '†' : '';
    return `| \`${key}\` | ${cell(text)} | none | ${flag} |`;
  });
  return [
    '# Site copy review: first-release seed (HEAAA-799)',
    '',
    `Seed version: \`${SEED_VERSION}\`. Source: \`apps/cms/src/seed/copy.ts\`. This file is generated from it and a test fails if they differ.`,
    '',
    '**Review status: authored by the Frontend Engineer; awaiting independent review. Not legal or clinical advice. Every legal page is a complete conservative default applied under the autonomous rule (go-live item 25, "default applied (autonomous)"); each statement describes only what this website does (HEAAA-838).** Owner ruling 2026-11-11 (C) item 5: no medical claims; the site never shows invented facts. † = counsel must confirm before go-live.',
    '',
    '## Not seeded on purpose (the organisation enters these in the CMS `Organisation details` global at go-live)',
    '',
    'Organisation name, address, phone, e-mail, hours and clinicians. The privacy and accessibility pages show the organisation’s phone, e-mail and address only when entered. The optional Notice of Privacy Practices (`legal.npp`) is entered by the organisation at go-live; while empty the page, its footer link, its sitemap entry and the link from the privacy page are omitted. Until entered, the site omits them (no placeholder fact, no fabricated value). Locations, services and doctors come from the directory API, not from this copy.',
    '',
    '## Seeded strings',
    '',
    '| Key | Text | Medical claim | Counsel † |',
    '| --- | ---- | ------------- | --------- |',
    ...rows,
    '',
    'Medical-claim screen (automated, see `review-doc.ts`): every string above is checked against a list of claim terms (cure, treat, heal, diagnose, guarantee, best, leading, proven, effective, expert, specialist, outcome, prevent, therapy, safe, clinically). A word list is a screen, not a substitute for the reviewer reading each line.',
    '',
  ].join('\n');
}
