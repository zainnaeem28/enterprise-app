import { describe, expect, it } from 'vitest';
import { validateSlug } from './slug';
import { openValue, sealValue } from './signed';

describe('validateSlug', () => {
  it.each(['about', 'services/cardiology', 'a-1'])('accepts %s', (s) =>
    expect(validateSlug(s)).toBe(true),
  );
  it.each([
    '',
    'About',
    'a b',
    '/x',
    'x/',
    '../x',
    'a//b',
    'preview',
    'admin/x',
    'api',
    'my/portal',
  ])('rejects %j', (s) => expect(validateSlug(s)).not.toBe(true));
  it('rejects non-strings', () => expect(validateSlug(undefined)).not.toBe(true));
});

describe('sealed value', () => {
  const S = 'k'.repeat(40);
  it('round-trips, expires and detects tampering', () => {
    const t = sealValue(S, { a: 1 }, 2000);
    expect(openValue(S, t, 1000)).toEqual({ a: 1 });
    expect(openValue(S, t, 2000)).toBeNull();
    expect(openValue('z'.repeat(40), t, 1000)).toBeNull();
    expect(
      openValue(
        S,
        t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
        1000,
      ),
    ).toBeNull();
    expect(openValue(S, 'x', 1000)).toBeNull();
  });
});

describe('sealed value purposes', () => {
  it('a value sealed for the OAuth transaction is not valid as a session, and vice versa', async () => {
    const { SESSION_PURPOSE } = await import('./signed');
    const S = 'k'.repeat(40);
    const t = sealValue(S, { uid: 1 }, 2000);
    expect(openValue(S, t, 1000, SESSION_PURPOSE)).toBeNull();
  });
});
