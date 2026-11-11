import type { Payload } from 'payload';
import { SEED_VERSION, siteContentSeed } from './copy';

export interface SeedResult {
  siteContent: 'seeded' | 'already-seeded';
}

// Idempotent: writes the reviewed copy once (marked by `seedVersion`) and never overwrites later edits. Organisation facts
// are NOT seeded; the organisation fills them in at go-live. Re-running changes nothing.
export async function seedContent(payload: Payload): Promise<SeedResult> {
  const current = (await payload.findGlobal({ slug: 'site-content', draft: true, depth: 0 })) as {
    seedVersion?: string | null;
  };
  if (current.seedVersion) return { siteContent: 'already-seeded' };
  await payload.updateGlobal({
    slug: 'site-content',
    data: { ...siteContentSeed, seedVersion: SEED_VERSION, _status: 'published' },
    depth: 0,
  });
  return { siteContent: 'seeded' };
}
