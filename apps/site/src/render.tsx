import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Template } from './analytics.js';
import type { SiteConfig } from './config.js';
import type { ContentSource } from './content.js';
import { UUID_RE, loadDirectory } from './directory.js';
import type { Directory, DirectoryClient, Freshness, NextSlot, SiteBanner } from './directory.js';
import { Layout } from './components/Layout.js';
import { bookUrl } from './handoff.js';
import {
  AboutPage,
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
  banners?: SiteBanner[];
}

export interface RenderDeps {
  config: SiteConfig;
  client: DirectoryClient;
  content: ContentSource;
  /** The CMS could not be read: the page used a stale answer or the static copy and must not sit in a CDN cache. */
  contentDegraded?: boolean;
}

const LEGAL = ['privacy', 'terms', 'cookies', 'accessibility', 'npp'] as const;

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
  const name = content.organisation.name;
  const titled = (t: string): string => (name === null ? t : `${t} – ${name}`);
  const o_ld = (origin: string) => organisationLd(origin, name);
  const fresh: Freshness = { stale: false };
  const dir = await readDirectory(client, fresh);
  const banners = (await client.banners?.()) ?? [];
  const ctx: Ctx = { patientOrigin: config.patientOrigin, content, dir };
  const o = config.siteOrigin;
  const desc = 'Find a service, choose a doctor and a location, and start your booking.';
  let spec: PageSpec;

  if (path === '/') {
    spec = {
      status: 200,
      template: 'home',
      title: name === null ? 'Book an appointment' : `${name} – book an appointment`,
      description: desc,
      path,
      body: <HomePage ctx={ctx} />,
      jsonLd: [o_ld(o)],
    };
  } else if (path === '/about') {
    spec = {
      status: 200,
      template: 'about',
      title: titled('About'),
      description: 'Who we are, what we offer and how to book an appointment.',
      path,
      body: <AboutPage ctx={ctx} />,
      jsonLd: [
        o_ld(o),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'About', path },
        ]),
      ],
    };
  } else if (path === '/services') {
    spec = {
      status: 200,
      template: 'services',
      title: titled('Services'),
      description: 'The services we offer and how long each appointment takes.',
      path,
      body: <ServicesPage ctx={ctx} />,
      jsonLd: [
        ...(dir !== null ? [servicesLd(o, dir.services, name)] : []),
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
      title: titled('Find a doctor'),
      description: 'Our doctors and the next available appointment for each.',
      path,
      body: <DoctorsPage ctx={ctx} slots={slots} />,
      jsonLd: [
        ...(dir?.doctors.map((d) => doctorLd(o, d, name)) ?? []),
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
      spec = notFound(path, titled);
    } else if (doctor === undefined) {
      // The directory is down: say so (503) instead of a "not found" that search engines would keep.
      spec = {
        ...notFound(path, titled),
        status: 503,
        title: titled('Temporarily unavailable'),
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
        title: titled(doctor.name),
        description: `Book an appointment with ${doctor.name}.`,
        path,
        body: <DoctorPage ctx={ctx} doctor={doctor} slots={slots} />,
        jsonLd: [
          doctorLd(o, doctor, name),
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
      title: titled('Locations'),
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
      title: titled('Contact'),
      description: 'How to reach us and where our locations are.',
      path,
      body: <ContactPage ctx={ctx} />,
      jsonLd: [
        o_ld(o),
        breadcrumbLd(o, [
          { name: 'Home', path: '/' },
          { name: 'Contact', path },
        ]),
      ],
    };
  } else if (path.startsWith('/legal/') && (LEGAL as readonly string[]).includes(path.slice(7))) {
    const key = path.slice(7) as (typeof LEGAL)[number];
    const page = content.legal[key];
    spec =
      page === null
        ? notFound(path, titled)
        : {
            status: 200,
            template: 'legal',
            title: titled(page.title),
            description: page.description,
            path,
            body: (
              <LegalPageView
                page={page}
                organisation={
                  key === 'privacy' || key === 'accessibility' ? content.organisation : undefined
                }
                nppHref={key === 'privacy' && content.legal.npp !== null ? '/legal/npp' : undefined}
              />
            ),
            jsonLd: [],
          };
  } else {
    spec = notFound(path, titled);
  }

  return {
    status: spec.status,
    // Built from the stale fallback means no-store: the CDN must not keep an unlisted clinician past the TTL (PB-4).
    cacheable:
      deps.contentDegraded !== true &&
      spec.status === 200 &&
      (spec.template === 'legal' || (dir !== null && !fresh.stale)),
    html: document({ ...spec, banners }, config, name, content.legal.npp !== null),
  };
}

function UnavailableNote() {
  return <p>This page can’t be loaded right now. Please try again in a few minutes.</p>;
}

function notFound(path: string, titled: (t: string) => string): PageSpec {
  return {
    status: 404,
    template: 'not-found',
    title: titled('Page not found'),
    description: 'This page does not exist.',
    path,
    body: <NotFoundPage />,
    jsonLd: [],
    noindex: true,
  };
}

function document(
  p: PageSpec,
  config: SiteConfig,
  siteName: string | null,
  hasNpp: boolean,
): string {
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
        {siteName !== null && <meta property="og:site_name" content={siteName} />}
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
        <Layout
          current={p.path}
          bookHref={bookHref}
          banners={p.banners ?? []}
          siteName={siteName}
          hasNpp={hasNpp}
        >
          {p.body}
        </Layout>
        <div id="consent-root" />
        <script type="module" src="/assets/site.js" />
      </body>
    </html>
  );
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}
