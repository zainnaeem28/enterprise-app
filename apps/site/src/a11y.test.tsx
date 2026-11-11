// @vitest-environment jsdom
import axe from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsentBanner } from './components/ConsentBanner.js';
import { Layout } from './components/Layout.js';
import { defaultContent } from './content.js';
import type { Directory } from './directory.js';
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

// jsdom axe: structure, names, roles, landmarks, ARIA. Colour contrast and layout need a real browser (the Playwright axe
// run in e2e/); this suite does not claim them.
const S = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const dir: Directory = {
  services: [{ id: S, name: 'General visit', durationMin: 20, mode: 'in_person' }],
  locations: [
    {
      id: L,
      name: 'Main Clinic',
      kind: 'clinic',
      timeZone: 'UTC',
      addressLines: ['1 Main St'],
      stateCode: 'IL',
      phone: '+1 555 0100',
      geo: { lat: 1, lng: 2 },
    },
  ],
  doctors: [{ id: D, name: 'Dr. Sample Doctor', serviceIds: [S], locationIds: [L] }],
};
const ctx = (d: Directory | null): Ctx => ({
  patientOrigin: 'https://my.example.org',
  content: defaultContent,
  dir: d,
});
const slots = new Map([
  [D, { state: 'slot' as const, startsAt: '2026-11-10T14:00:00.000Z' }],
  [S, { state: 'none' as const }],
]);

const pages: Record<string, () => React.ReactNode> = {
  home: () => <HomePage ctx={ctx(dir)} />,
  about: () => <AboutPage ctx={ctx(dir)} />,
  'about, directory down': () => <AboutPage ctx={ctx(null)} />,
  services: () => <ServicesPage ctx={ctx(dir)} />,
  doctors: () => <DoctorsPage ctx={ctx(dir)} slots={slots} />,
  doctor: () => <DoctorPage ctx={ctx(dir)} doctor={dir.doctors[0]!} slots={slots} />,
  locations: () => <LocationsPage ctx={ctx(dir)} />,
  contact: () => <ContactPage ctx={ctx(dir)} />,
  legal: () => <LegalPageView page={defaultContent.legal.privacy} />,
  'not found': () => <NotFoundPage />,
  'directory down': () => <DoctorsPage ctx={ctx(null)} slots={new Map()} />,
  'directory empty': () => (
    <DoctorsPage ctx={ctx({ services: [], locations: [], doctors: [] })} slots={new Map()} />
  ),
};

async function violations(markup: string) {
  document.documentElement.lang = 'en';
  document.title = 'Test page';
  document.body.innerHTML = markup;
  const r = await axe.run(document.body, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('axe (jsdom) on every page state', () => {
  for (const [name, page] of Object.entries(pages))
    it(name, async () => {
      expect(
        await violations(
          renderToStaticMarkup(
            <Layout current="/" bookHref="https://my.example.org/book">
              {page()}
            </Layout>,
          ),
        ),
      ).toEqual([]);
    });
  it('cookie banner', async () => {
    expect(
      await violations(
        renderToStaticMarkup(
          <main>
            <h1>x</h1>
            <ConsentBanner onChoose={() => undefined} />
          </main>,
        ),
      ),
    ).toEqual([]);
  });
});

describe('services mode label (INT03-F22)', () => {
  const html = (mode: string) =>
    renderToStaticMarkup(
      <ServicesPage
        ctx={ctx({ ...dir, services: [{ id: S, name: 'Visit', durationMin: 20, mode }] })}
      />,
    );
  it('labels the API mode "video" as a video visit', () => {
    expect(html('video')).toContain('Video visit');
    expect(html('video')).not.toContain('In person');
  });
  it('labels in_person as in person', () => {
    expect(html('in_person')).toContain('In person');
  });
});
