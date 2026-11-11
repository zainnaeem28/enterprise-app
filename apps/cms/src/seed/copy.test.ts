import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seededStrings, siteContentSeed } from './copy';
import { CLAIM_TERMS, renderReviewDoc } from './review-doc';

const DOC = resolve(__dirname, '../../../../docs/content/SITE-COPY-REVIEW.md');

describe('seed copy', () => {
  it('makes no medical claim (word screen over every seeded string)', () => {
    for (const { key, text } of seededStrings()) expect(text, key).not.toMatch(CLAIM_TERMS);
  });

  it('states no organisation fact: no e-mail, phone number, street address or digits other than the emergency number and WCAG', () => {
    for (const { key, text } of seededStrings()) {
      expect(text, key).not.toMatch(/@/);
      const digits = text.replace(/\b911\b/g, '').replace(/WCAG 2\.2/g, '');
      expect(digits, key).not.toMatch(/\d/);
    }
  });

  it('seeds nothing for organisation name, address, phone, e-mail, hours or clinicians', () => {
    expect(Object.keys(siteContentSeed).sort()).toEqual(['about', 'contact', 'home', 'legal']);
    expect(Object.keys(siteContentSeed.contact)).toEqual(['intro']);
  });

  it('every seeded string is listed in docs/content/SITE-COPY-REVIEW.md (generated)', () => {
    if (process.env['UPDATE_REVIEW_DOC'] === '1') writeFileSync(DOC, renderReviewDoc());
    expect(readFileSync(DOC, 'utf8')).toBe(renderReviewDoc());
  });
});
