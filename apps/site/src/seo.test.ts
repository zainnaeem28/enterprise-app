import { describe, expect, it } from 'vitest';
import { SITE_NAME, doctorLd, jsonLdText, locationLd, robotsTxt, sitemapXml } from './seo.js';

const D = '33333333-3333-4333-8333-333333333333';

describe('seo (TC-BS-05)', () => {
  it('JSON-LD cannot close its script element', () => {
    expect(jsonLdText({ a: '</script><script>alert(1)</script>' })).not.toContain('</script>');
    expect(JSON.parse(jsonLdText({ a: '</x> ' }))).toEqual({ a: '</x> ' });
  });
  it('doctor structured data has name and url only', () => {
    expect(
      doctorLd('https://www.example.org', { id: D, name: 'Dr A', serviceIds: [], locationIds: [] }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Physician',
      name: 'Dr A',
      url: `https://www.example.org/doctors/${D}`,
      worksFor: { '@type': 'MedicalOrganization', name: SITE_NAME },
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

describe('visible brand text', () => {
  it('has no "placeholder" or bracketed product name in the default content or site name', async () => {
    const { defaultContent } = await import('./content.js');
    const { SITE_NAME } = await import('./seo.js');
    expect(JSON.stringify(defaultContent)).not.toMatch(/placeholder/i);
    expect(SITE_NAME).not.toMatch(/placeholder|\[/i);
  });
});
