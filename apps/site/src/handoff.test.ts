import { describe, expect, it } from 'vitest';
import { bookUrl } from './handoff.js';

const S = '11111111-1111-4111-8111-111111111111';
const D = '33333333-3333-4333-8333-333333333333';

describe('bookUrl (TC-BS-02)', () => {
  it('carries the service and doctor as opaque IDs and nothing else', () => {
    const u = new URL(bookUrl('https://my.example.org', { serviceId: S, clinicianId: D }));
    expect(u.origin).toBe('https://my.example.org');
    expect(u.pathname).toBe('/book');
    expect([...u.searchParams.entries()]).toEqual([
      ['serviceId', S],
      ['clinicianId', D],
    ]);
  });
  it('drops anything that is not a UUID, so a name or free text never travels', () => {
    const u = new URL(
      bookUrl('https://my.example.org', { serviceId: 'Jane Doe 1980-01-01', clinicianId: D }),
    );
    expect([...u.searchParams.keys()]).toEqual(['clinicianId']);
  });
  it('without a selection is the plain booking entry', () => {
    expect(bookUrl('https://my.example.org', {})).toBe('https://my.example.org/book');
  });
});
