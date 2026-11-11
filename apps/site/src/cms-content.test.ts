import { describe, expect, it, vi } from 'vitest';
import { siteContentSeed } from '../../cms/src/seed/copy';
import { createCmsContent, parseOrganisation, parseSiteContent } from './cms-content.js';
import { emptyOrganisation, placeholderContent } from './content.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('static fallback', () => {
  it('equals the reviewed seed copy in apps/cms and holds no organisation fact', () => {
    const c = placeholderContent;
    expect(c.home).toEqual(siteContentSeed.home);
    expect(c.about).toEqual(siteContentSeed.about);
    expect(c.contact).toEqual(siteContentSeed.contact);
    for (const k of ['privacy', 'terms', 'cookies', 'accessibility'] as const) {
      const s = siteContentSeed.legal[k];
      expect(c.legal[k]).toEqual({
        title: s.title,
        description: s.description,
        paragraphs: s.body.split('\n\n'),
      });
    }
    expect(c.organisation).toEqual(emptyOrganisation);
  });
});

describe('parseOrganisation (no invented facts)', () => {
  it('nothing, junk or blanks give empty facts', () => {
    expect(parseOrganisation(null)).toEqual(emptyOrganisation);
    expect(parseOrganisation({})).toEqual(emptyOrganisation);
    expect(
      parseOrganisation({
        name: '  ',
        address: '\n \n',
        phone: 5,
        email: 'nope',
        clinicians: [{}, 3],
      }),
    ).toEqual(emptyOrganisation);
  });
  it('keeps what was entered, trimmed', () => {
    expect(
      parseOrganisation({
        name: ' Example Practice ',
        address: '1 Example Street\n Springfield ',
        phone: '+1 555 0100',
        email: 'hello@example.org',
        hours: 'Mon-Fri 9-5',
        clinicians: [
          { name: 'Dr. Sample Doctor', title: ' Physician ' },
          { name: 'Dr. B', title: '' },
        ],
      }),
    ).toEqual({
      name: 'Example Practice',
      addressLines: ['1 Example Street', 'Springfield'],
      phone: '+1 555 0100',
      email: 'hello@example.org',
      hours: 'Mon-Fri 9-5',
      clinicians: [
        { name: 'Dr. Sample Doctor', title: 'Physician' },
        { name: 'Dr. B', title: null },
      ],
    });
  });
});

describe('parseSiteContent', () => {
  it('uses CMS text and falls back per field', () => {
    const c = parseSiteContent({
      home: { heading: 'Edited heading', intro: '' },
      legal: { privacy: { title: 'Privacy notice', body: 'One.\n\nTwo.' }, terms: 'bad' },
    });
    expect(c.home.heading).toBe('Edited heading');
    expect(c.home.intro).toBe(placeholderContent.home.intro);
    expect(c.legal.privacy.title).toBe('Privacy notice');
    expect(c.legal.privacy.paragraphs).toEqual(['One.', 'Two.']);
    expect(c.legal.privacy.description).toBe(placeholderContent.legal.privacy.description);
    expect(c.legal.terms).toEqual(placeholderContent.legal.terms);
  });
});

describe('createCmsContent', () => {
  const ok = (site: unknown, org: unknown) =>
    vi.fn(async (u: unknown) => (String(u).includes('/organisation') ? json(org) : json(site)));

  it('reads both globals anonymously from the CMS origin and caches for the ttl', async () => {
    const f = ok({ home: { heading: 'H' } }, { name: 'Example Practice' });
    let t = 0;
    const get = createCmsContent({
      baseUrl: 'https://cms.example.org/ignored/path',
      fetchImpl: f as unknown as typeof fetch,
      now: () => t,
    });
    const r = await get();
    expect(r.degraded).toBe(false);
    expect(r.content.home.heading).toBe('H');
    expect(r.content.organisation.name).toBe('Example Practice');
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://cms.example.org/api/globals/site-content?depth=0',
      'https://cms.example.org/api/globals/organisation?depth=0',
    ]);
    t = 59_000;
    await get();
    expect(f).toHaveBeenCalledTimes(2);
    t = 61_000;
    await get();
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('unpublished globals (403/404) mean nothing entered, not a failure', async () => {
    const f = vi.fn(async () => json({ errors: [] }, 403));
    const r = await createCmsContent({
      baseUrl: 'https://cms.example.org',
      fetchImpl: f as unknown as typeof fetch,
    })();
    expect(r.degraded).toBe(false);
    expect(r.content).toEqual(placeholderContent);
  });

  it('on failure serves the last good answer for 10 minutes, then the static copy, flagged degraded', async () => {
    let t = 0;
    let up = true;
    const f = vi.fn(async (u: unknown) => {
      if (!up) throw new Error('down');
      return String(u).includes('/organisation') ? json({ phone: '+1 555 0100' }) : json({});
    });
    const get = createCmsContent({
      baseUrl: 'https://cms.example.org',
      fetchImpl: f as unknown as typeof fetch,
      now: () => t,
    });
    await get();
    up = false;
    t = 120_000;
    const stale = await get();
    expect(stale.degraded).toBe(true);
    expect(stale.content.organisation.phone).toBe('+1 555 0100');
    t = 700_000;
    const gone = await get();
    expect(gone.degraded).toBe(true);
    expect(gone.content).toEqual(placeholderContent);
    expect(gone.content.organisation).toEqual(emptyOrganisation);
  });

  it('a 5xx or invalid JSON is a failure', async () => {
    for (const bad of [
      async () => json({}, 500),
      async () => new Response('<html>', { status: 200 }),
    ]) {
      const r = await createCmsContent({
        baseUrl: 'https://cms.example.org',
        fetchImpl: bad as unknown as typeof fetch,
      })();
      expect(r.degraded).toBe(true);
      expect(r.content).toEqual(placeholderContent);
    }
  });
});
