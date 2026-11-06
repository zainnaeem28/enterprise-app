import { describe, expect, it } from 'vitest';
import { checkedReturnTo, DEFAULT_RETURN_TO } from './returnTo.js';

describe('checkedReturnTo', () => {
  it.each(['/account', '/visits?x=1', '/a/b#c'])('keeps the relative path %s', (v) => {
    expect(checkedReturnTo(v)).toBe(v);
  });
  it.each([
    undefined,
    null,
    '',
    'account',
    '//evil.example',
    'https://evil.example/',
    '/\\evil.example',
    '/a\nb',
    '/' + 'a'.repeat(600),
    'javascript:alert(1)',
  ])('replaces %s with the default', (v) => {
    expect(checkedReturnTo(v)).toBe(DEFAULT_RETURN_TO);
  });
});
