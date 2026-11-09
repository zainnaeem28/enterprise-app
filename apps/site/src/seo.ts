// Metadata, structured data, sitemap and robots (F-BS-05). Structured data names organisations, places and listed clinicians
// only: no patient, appointment or health information exists in the data this site reads.
import type { Directory, Doctor, Location, Service } from './directory.js';

export const SITE_NAME = '[Product name]';

export const jsonLdText = (data: unknown): string =>
  JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');

const url = (origin: string, path: string) => new URL(path, origin).toString();

export function organisationLd(origin: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalOrganization',
    name: SITE_NAME,
    url: url(origin, '/'),
  };
}

export function locationLd(origin: string, l: Location) {
  return {
    '@context': 'https://schema.org',
    '@type': 'MedicalClinic',
    name: l.name,
    url: url(origin, '/locations'),
    ...(l.phone !== null ? { telephone: l.phone } : {}),
    ...(l.addressLines.length > 0
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: l.addressLines.join(', '),
            ...(l.stateCode !== '' ? { addressRegion: l.stateCode } : {}),
          },
        }
      : {}),
    ...(l.geo !== null
      ? { geo: { '@type': 'GeoCoordinates', latitude: l.geo.lat, longitude: l.geo.lng } }
      : {}),
  };
}

export function doctorLd(origin: string, d: Doctor) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Physician',
    name: d.name,
    url: url(origin, `/doctors/${d.id}`),
    worksFor: { '@type': 'MedicalOrganization', name: SITE_NAME },
  };
}

export function servicesLd(origin: string, services: Service[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: services.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Service',
        name: s.name,
        provider: { '@type': 'MedicalOrganization', name: SITE_NAME, url: url(origin, '/') },
      },
    })),
  };
}

export function breadcrumbLd(origin: string, trail: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: url(origin, t.path),
    })),
  };
}

export const STATIC_PATHS = [
  '/',
  '/about',
  '/services',
  '/doctors',
  '/locations',
  '/contact',
  '/legal/privacy',
  '/legal/terms',
  '/legal/cookies',
  '/legal/accessibility',
] as const;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sitemapXml(origin: string, dir: Directory | null): string {
  const paths: string[] = [...STATIC_PATHS, ...(dir?.doctors.map((d) => `/doctors/${d.id}`) ?? [])];
  const body = paths.map((p) => `  <url><loc>${xml(url(origin, p))}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export const robotsTxt = (origin: string): string =>
  `User-agent: *\nAllow: /\n\nSitemap: ${url(origin, '/sitemap.xml')}\n`;
