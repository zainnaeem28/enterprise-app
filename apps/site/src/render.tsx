import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Template } from './analytics.js';
import type { SiteConfig } from './config.js';
import type { ContentSource } from './content.js';
import { UUID_RE, loadDirectory } from './directory.js';
import type { Directory, DirectoryClient, Freshness, NextSlot } from './directory.js';
import { Layout } from './components/Layout.js';
import { bookUrl } from './handoff.js';
import {
  ContactPage,
  DoctorPage,
  DoctorsPage,
  HomePage,
  LegalPageView,
  LocationsPage,
  NotFoundPage,
  ServicesPage,
} from './pages/pages.js';
import type { Ctx } from './pages/pages.js';
import {
  SITE_NAME,
  breadcrumbLd,
  doctorLd,
  jsonLdText,
  locationLd,
  organisationLd,
  servicesLd,
} from './seo.js';

export interface Rendered {
  status: number;
  html: string;
  /** Degraded and error pages must not sit in the CDN cache for a minute (PB-4). */
  cacheable: boolean;
}

interface PageSpec {
  status: number;
  template: Template;
  title: string;
  description: string;
  path: string;
  body: ReactNode;
  jsonLd: unknown[];
  noindex?: boolean;
}

export interface RenderDeps {
  config: SiteConfig;
  client: DirectoryClient;
  content: ContentSource;
}

const LEGAL = ['privacy', 'terms', 'cookies', 'accessibility'] as const;

async function readDirectory(
  client: DirectoryClient,
  fresh?: Freshness,
): Promise<Directory | null> {
  try {
    return await loadDirectory(client, fresh);
  } catch {
    return null;
  }
}

export const directoryOrNull = readDirectory;

async function slotsFor(
  client: DirectoryClient,
  pairs: { key: string; clinicianId: string; serviceId: string }[],
  fresh: Freshness,
): Promise<Map<string, NextSlot>> {
  const out = await Promise.all(
    pairs.map(
      async (p) => [p.key, await client.nextAvailable(p.clinicianId, p.serviceId, fresh)] as const,
    ),
  );
  return new Map(out);
}

export async function route(path: string, deps: RenderDeps): Promise<Rendered> {
  const { config, client, content } = deps;
  const fresh: Freshness = { stale: false };
  const dir = await readDirectory(client, fresh);
  const ctx: Ctx = { patientOrigin: config.patientOrigin, content, dir };
  const o = config.siteOrigin;
  const desc = 'Find a service, choose a doctor and a location, and start your booking.';
  let spec: PageSpec;

  if (path === '/') {
    spec = {
      status: 200,
      template: 'home',
      title: `${SITE_NAME} – book an appointment`,
      description: desc,
      path,
      body: <HomePage ctx={ctx} />,
      jsonLd: [organisationLd(o)],
    };
  } else if (path === '/services') {
    spec = {
      status: 200,
      template: 'services',
      title: `Services – ${SITE_NAME}`,
      description: 'The services we offer and how long each appointment takes.',
      path,
      body: <ServicesPage ctx={ctx} />,
      jsonLd: [
        ...(dir !== null ? [servicesLd(o, dir.services)] : []),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'Services', path },
        ]),
      ],
    };
  } else if (path === '/doctors') {
    const slots =
      dir === null
        ? new Map<string, NextSlot>()
        : await slotsFor(
            client,
            dir.doctors.flatMap((d) =>
              d.serviceIds[0] === undefined
                ? []
                : [{ key: d.id, clinicianId: d.id, serviceId: d.serviceIds[0] }],
            ),
            fresh,
          );
    spec = {
      status: 200,
      template: 'doctors',
      title: `Find a doctor – ${SITE_NAME}`,
      description: 'Our doctors and the next available appointment for each.',
      path,
      body: <DoctorsPage ctx={ctx} slots={slots} />,
      jsonLd: [
        ...(dir?.doctors.map((d) => doctorLd(o, d)) ?? []),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'Find a doctor', path },
        ]),
      ],
    };
  } else if (path.startsWith('/doctors/')) {
    const id = path.slice('/doctors/'.length).toLowerCase();
    const doctor = UUID_RE.test(id) ? dir?.doctors.find((d) => d.id === id) : undefined;
    if (dir !== null && doctor === undefined) {
      spec = notFound(path);
    } else if (doctor === undefined) {
      // The directory is down: say so (503) instead of a "not found" that search engines would keep.
      spec = {
        ...notFound(path),
        status: 503,
        title: `Temporarily unavailable – ${SITE_NAME}`,
        body: <UnavailableNote />,
      };
    } else {
      const slots = await slotsFor(
        client,
        doctor.serviceIds.map((sid) => ({ key: sid, clinicianId: doctor.id, serviceId: sid })),
        fresh,
      );
      spec = {
        status: 200,
        template: 'doctor-profile',
        title: `${doctor.name} – ${SITE_NAME}`,
        description: `Book an appointment with ${doctor.name}.`,
        path,
        body: <DoctorPage ctx={ctx} doctor={doctor} slots={slots} />,
        jsonLd: [
          doctorLd(o, doctor),
          breadcrumbLd(o, [
            { name: 'Home', path: '/' },
            { name: 'Find a doctor', path: '/doctors' },
            { name: doctor.name, path },
          ]),
        ],
      };
    }
  } else if (path === '/locations') {
    spec = {
      status: 200,
      template: 'locations',
      title: `Locations – ${SITE_NAME}`,
      description: 'Where to find us: addresses and phone numbers.',
      path,
      body: <LocationsPage ctx={ctx} />,
      jsonLd: [
        ...(dir?.locations.map((l) => locationLd(o, l)) ?? []),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'Locations', path },
        ]),
      ],
    };
  } else if (path === '/contact') {
    spec = {
      status: 200,
      template: 'contact',
      title: `Contact – ${SITE_NAME}`,
      description: 'How to reach us and where our locations are.',
      path,
      body: <ContactPage ctx={ctx} />,
      jsonLd: [
        organisationLd(o),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'Contact', path },
        ]),
      ],
    };
  } else if (path.startsWith('/legal/') && (LEGAL as readonly string[]).includes(path.slice(7))) {
    const page = content.legal[path.slice(7) as (typeof LEGAL)[number]];
    spec = {
      status: 200,
      template: 'legal',
      title: `${page.title} – ${SITE_NAME}`,
      description: page.description,
      path,
      body: <LegalPageView page={page} />,
      jsonLd: [],
    };
  } else {
    spec = notFound(path);
  }

  return {
    status: spec.status,
    // Built from the stale fallback means no-store: the CDN must not keep an unlisted clinician past the TTL (PB-4).
    cacheable: spec.status === 200 && (spec.template === 'legal' || (dir !== null && !fresh.stale)),
    html: document(spec, config),
  };
}

function UnavailableNote() {
  return <p>This page can’t be loaded right now. Please try again in a few minutes.</p>;
}

function notFound(path: string): PageSpec {
  return {
    status: 404,
    template: 'not-found',
    title: `Page not found – ${SITE_NAME}`,
    description: 'This page does not exist.',
    path,
    body: <NotFoundPage />,
    jsonLd: [],
    noindex: true,
  };
}

function document(p: PageSpec, config: SiteConfig): string {
  const canonical = new URL(p.path, config.siteOrigin).toString();
  const bookHref = bookUrl(config.patientOrigin, {});
  const page = (
    <html lang="en" data-portal="brand">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{p.title}</title>
        <meta name="description" content={p.description} />
        {p.noindex === true ? (
          <meta name="robots" content="noindex" />
        ) : (
          <link rel="canonical" href={canonical} />
        )}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={SITE_NAME} />
        <meta property="og:title" content={p.title} />
        <meta property="og:description" content={p.description} />
        <meta property="og:url" content={canonical} />
        <meta name="twitter:card" content="summary" />
        <link rel="stylesheet" href="/assets/site.css" />
        {p.jsonLd.map((d, i) => (
          <script
            key={i}
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: jsonLdText(d) }}
          />
        ))}
      </head>
      <body data-template={p.template} data-analytics-src={config.analyticsSrc ?? ''}>
        <Layout current={p.path} bookHref={bookHref}>
          {p.body}
        </Layout>
        <div id="consent-root" />
        <script type="module" src="/assets/site.js" />
      </body>
    </html>
  );
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}
