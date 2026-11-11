import { describe, expect, it } from 'vitest';
import { doctorLd, jsonLdText, locationLd, organisationLd, robotsTxt, sitemapXml } from './seo.js';

const D = '33333333-3333-4333-8333-333333333333';

describe('seo (TC-BS-05)', () => {
  it('JSON-LD cannot close its script element', () => {
    expect(jsonLdText({ a: '</script><script>alert(1)</script>' })).not.toContain('</script>');
    expect(JSON.parse(jsonLdText({ a: '</x> ' }))).toEqual({ a: '</x> ' });
  });
  it('doctor structured data has name and url only', () => {
    expect(
      doctorLd(
        'https://www.example.org',
        { id: D, name: 'Dr A', serviceIds: [], locationIds: [] },
        null,
      ),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Physician',
      name: 'Dr A',
      url: `https://www.example.org/doctors/${D}`,
    });
  });
  it('names the organisation only when the CMS has it', () => {
    const d = { id: D, name: 'Dr A', serviceIds: [], locationIds: [] };
    expect(doctorLd('https://www.example.org', d, 'Example Practice')).toMatchObject({
      worksFor: { name: 'Example Practice' },
    });
    expect(organisationLd('https://www.example.org', null)).not.toHaveProperty('name');
    expect(organisationLd('https://www.example.org', 'Example Practice')).toMatchObject({
      name: 'Example Practice',
    });
  });
  it('location structured data omits what is absent', () => {
    const ld = locationLd('https://www.example.org', {
      id: D,
      name: 'Main',
      kind: 'clinic',
      timeZone: 'UTC',
      addressLines: [],
      stateCode: '',
      phone: null,
      geo: null,
    });
    expect(Object.keys(ld)).toEqual(['@context', '@type', 'name', 'url']);
  });
  it('sitemap lists static pages and every doctor; robots points to it', () => {
    const xml = sitemapXml('https://www.example.org', {
      services: [],
      locations: [],
      doctors: [{ id: D, name: 'Dr A', serviceIds: [], locationIds: [] }],
    });
    expect(xml).toContain('<loc>https://www.example.org/about</loc>');
    expect(xml).toContain('<loc>https://www.example.org/doctors</loc>');
    expect(xml).toContain(`<loc>https://www.example.org/doctors/${D}</loc>`);
    expect(robotsTxt('https://www.example.org')).toContain(
      'Sitemap: https://www.example.org/sitemap.xml',
    );
  });
});
