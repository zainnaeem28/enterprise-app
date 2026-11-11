import { getPayload, type Payload } from 'payload';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCmsContent } from '../../../site/src/cms-content';
import { emptyOrganisation, placeholderContent } from '../../../site/src/content';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';
import { goodEnv } from '../test-env';
import { seedContent } from './seed';

const DB = process.env['CMS_TEST_DATABASE_URL'];
const describeDb = DB ? describe : describe.skip;

// The site's real ContentSource (apps/site/src/cms-content.ts) reading the real CMS REST API (Payload route handler,
// anonymous request) over the real cms schema in PostgreSQL. Only the HTTP transport is in-process.
describeDb('site ContentSource against the real CMS REST API + PostgreSQL', () => {
  let payload: Payload;
  let fetchImpl: typeof fetch;

  beforeAll(async () => {
    for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, '');
    for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CMS_DATABASE_URL', DB!);
    vi.stubEnv('CMS_PUBLIC_URL', 'http://localhost:3187');
    vi.stubEnv('CMS_SITE_PREVIEW_URL', 'http://localhost:3000');
    const { default: config } = await import('../payload.config');
    const { REST_GET } = await import('@payloadcms/next/routes');
    payload = await getPayload({ config });
    const handler = REST_GET(config);
    fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      const slug = url.pathname.replace(/^\/api\//, '').split('/');
      return handler(new Request(url), { params: Promise.resolve({ slug }) });
    }) as typeof fetch;
    // Throwaway database only: reset to "never seeded, organisation empty".
    await payload.updateGlobal({
      slug: 'site-content',
      data: { seedVersion: null, _status: 'published' },
      depth: 0,
    });
    await payload.updateGlobal({
      slug: 'organisation',
      data: {
        name: null,
        address: null,
        phone: null,
        email: null,
        hours: null,
        clinicians: [],
        _status: 'published',
      },
      depth: 0,
    });
  });
  afterAll(async () => {
    await payload?.db.destroy?.();
    vi.unstubAllEnvs();
  });

  const read = () =>
    createCmsContent({ baseUrl: 'https://cms.example.org', fetchImpl, ttlMs: 0 })();

  it('seeded copy comes through the REST API and equals the site fallback; organisation is empty', async () => {
    await seedContent(payload);
    const { content, degraded } = await read();
    expect(degraded).toBe(false);
    expect(content).toEqual(placeholderContent);
    expect(content.organisation).toEqual(emptyOrganisation);
  });

  it('an editor change to the text and a published organisation entry reach the site', async () => {
    await payload.updateGlobal({
      slug: 'site-content',
      data: { home: { heading: 'Edited heading', intro: 'Edited intro' }, _status: 'published' },
      depth: 0,
    });
    await payload.updateGlobal({
      slug: 'organisation',
      data: {
        name: 'Example Practice',
        address: '1 Example Street\nSpringfield',
        phone: '+1 555 0100',
        email: 'hello@example.org',
        hours: 'Mon-Fri 9-5',
        clinicians: [{ name: 'Dr. Sample Doctor', title: 'Physician' }],
        _status: 'published',
      },
      depth: 0,
    });
    const { content } = await read();
    expect(content.home).toEqual({ heading: 'Edited heading', intro: 'Edited intro' });
    expect(content.organisation).toEqual({
      name: 'Example Practice',
      addressLines: ['1 Example Street', 'Springfield'],
      phone: '+1 555 0100',
      email: 'hello@example.org',
      hours: 'Mon-Fri 9-5',
      clinicians: [{ name: 'Dr. Sample Doctor', title: 'Physician' }],
    });
  });

  it('an unpublished draft is not visible to the site', async () => {
    await payload.updateGlobal({
      slug: 'organisation',
      data: { phone: '+1 555 9999', _status: 'draft' },
      draft: true,
      depth: 0,
    });
    expect((await read()).content.organisation.phone).toBe('+1 555 0100');
  });
});
