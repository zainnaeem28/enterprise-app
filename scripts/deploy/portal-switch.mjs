#!/usr/bin/env node
// Portal pointer switch (DEVOPS-PLAN 6.2, DPR-08). Assets are content-hashed and already uploaded by the build to the
// immutable assets/ prefix and releases/<sha>/ (build-release, DO-05). This step copies that release's entry document to
// the live path and invalidates ONLY the entry document and release.json. Rollback is the same step with the previous
// release's sha, run BEFORE the api/worker redeploy (9.3, DPR-08).
//   portal-switch.mjs --bucket B --sha SHA --portal staff --distribution ID [--source-bucket RELEASE_STORE] [--dry-run]
// --source-bucket: when releases/<sha>/ lives in the release store and not in the portal bucket (permission gap 5), the entry
// document and release.json are copied from there; the destination stays live/<portal>/ in --bucket. Default: --bucket.
import { aws } from './lib/aws.mjs';
import { args, isMain, main } from './lib/cli.mjs';

export function switchPlan({ sha, portal }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha must be 40 hex');
  if (!/^[a-z][a-z0-9-]*$/.test(portal)) throw new Error('--portal is malformed');
  return {
    copies: [
      { from: `releases/${sha}/bundles/${portal}/index.html`, to: `live/${portal}/index.html` },
      { from: `releases/${sha}/bundles/${portal}/release.json`, to: `live/${portal}/release.json` },
    ],
    invalidate: [`/${portal}/index.html`, `/${portal}/release.json`],
  };
}

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), {
      bucket: 'required',
      sha: 'required',
      portal: 'required',
      distribution: 'required',
      'source-bucket': 'optional',
      'dry-run': 'flag',
    });
    const p = switchPlan(a);
    for (const c of p.copies) {
      const src = a['source-bucket'] ?? a.bucket;
      console.log(`copy s3://${src}/${c.from} -> s3://${a.bucket}/${c.to}`);
      if (!a['dry-run'])
        aws([
          's3api',
          'copy-object',
          '--bucket',
          a.bucket,
          '--copy-source',
          `${src}/${c.from}`,
          '--key',
          c.to,
          '--cache-control',
          c.to.endsWith('release.json') ? 'no-cache' : 'max-age=60',
          '--metadata-directive',
          'REPLACE',
          '--content-type',
          c.to.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8',
        ]);
    }
    console.log(`invalidate ${p.invalidate.join(', ')}`);
    if (!a['dry-run'])
      aws([
        'cloudfront',
        'create-invalidation',
        '--distribution-id',
        a.distribution,
        '--paths',
        ...p.invalidate,
      ]);
  });
