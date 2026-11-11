import { getPayload, type Payload } from 'payload';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';
import { goodEnv } from '../test-env';
import { SEED_VERSION, siteContentSeed } from './copy';
import { seedContent } from './seed';

const DB = process.env['CMS_TEST_DATABASE_URL'];
const describeDb = DB ? describe : describe.skip;

describeDb('site content seed against real Payload + PostgreSQL', () => {
  let payload: Payload;
  beforeAll(async () => {
    for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, '');
    for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CMS_DATABASE_URL', DB!);
    vi.stubEnv('CMS_PUBLIC_URL', 'http://localhost:3187');
    vi.stubEnv('CMS_SITE_PREVIEW_URL', 'http://localhost:3000');
    const { default: config } = await import('../payload.config');
    payload = await getPayload({ config });
    // Throwaway database only: reset so the test is repeatable.
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

  const publicRead = (slug: 'site-content' | 'organisation') =>
    payload.findGlobal({ slug, overrideAccess: false, depth: 0 });

  it('seeds the reviewed copy once; the public (anonymous) read returns it', async () => {
    const first = await seedContent(payload);
    expect(first.siteContent).toBe('seeded');
    const pub = (await publicRead('site-content')) as unknown as typeof siteContentSeed & {
      seedVersion: string;
    };
    expect(pub.home).toMatchObject(siteContentSeed.home);
    expect(pub.about).toMatchObject(siteContentSeed.about);
    expect(pub.contact).toMatchObject(siteContentSeed.contact);
    expect(pub.legal.privacy).toMatchObject(siteContentSeed.legal.privacy);
    expect(pub.seedVersion).toBe(SEED_VERSION);
  });

  it('is idempotent and never overwrites an editor change', async () => {
    await payload.updateGlobal({
      slug: 'site-content',
      data: { home: { heading: 'Edited by the organisation', intro: 'x' }, _status: 'published' },
      depth: 0,
    });
    const versionsBefore = (await payload.findGlobalVersions({ slug: 'site-content', limit: 100 }))
      .totalDocs;
    const again = await seedContent(payload);
    expect(again.siteContent).toBe('already-seeded');
    const pub = (await publicRead('site-content')) as unknown as typeof siteContentSeed;
    expect(pub.home.heading).toBe('Edited by the organisation');
    expect((await payload.findGlobalVersions({ slug: 'site-content', limit: 100 })).totalDocs).toBe(
      versionsBefore,
    );
  });

  it('seeds no organisation facts: the public organisation global is empty', async () => {
    await seedContent(payload);
    const org = (await publicRead('organisation')) as unknown as Record<string, unknown>;
    for (const k of ['name', 'address', 'phone', 'email', 'hours'])
      expect(org[k] ?? null).toBeNull();
    expect((org['clinicians'] as unknown[] | undefined) ?? []).toHaveLength(0);
  });

  it('keeps an unpublished organisation draft out of the public read', async () => {
    await payload.updateGlobal({
      slug: 'organisation',
      data: { name: 'Draft Name', _status: 'draft' },
      draft: true,
      depth: 0,
    });
    const org = (await publicRead('organisation')) as unknown as Record<string, unknown>;
    expect(org['name'] ?? null).toBeNull();
  });
});
