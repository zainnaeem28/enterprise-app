#!/usr/bin/env node
// Marketing site publish (DEVOPS-PLAN 4.2, 9.1; DPR-12): static files to the marketing bucket, then a cache
// invalidation. Own account, own role gh-deploy-marketing-<env>, no PHI, no migration. A missing build directory is an
// error, never a silent no-op.
//   publish-marketing.mjs --dir apps/site/dist --bucket B --distribution ID [--dry-run]
import { existsSync, readdirSync } from 'node:fs';
import { aws } from './lib/aws.mjs';
import { args, isMain, main } from './lib/cli.mjs';

if (isMain(import.meta.url))
  main(() => {
    const a = args(process.argv.slice(2), {
      dir: 'required',
      bucket: 'required',
      distribution: 'required',
      'dry-run': 'flag',
    });
    if (!existsSync(a.dir) || readdirSync(a.dir).length === 0)
      throw new Error(
        `${a.dir} does not exist or is empty: the marketing site has no build output yet; nothing is published`,
      );
    console.log(`sync ${a.dir} -> s3://${a.bucket}/ (--delete)`);
    if (a['dry-run']) return;
    aws(['s3', 'sync', a.dir, `s3://${a.bucket}/`, '--delete'], { json: false });
    aws([
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      a.distribution,
      '--paths',
      '/*',
    ]);
  });
