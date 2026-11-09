#!/usr/bin/env node
// Task definitions are registered only by the human-applied approvals root (DEVOPS-PLAN 7.5, DPR-35/39); a workflow
// neither registers nor edits them. This finds the ONE active revision per family whose image equals the manifest's
// digest reference, so the rollout names a task-definition ARN, never "latest". Zero or several matches stop the run.
//   resolve-taskdefs.mjs --manifest m.json --family api=<family> --family worker=<family> [--migration-arn ARN --migration-image api]
import { readFileSync } from 'node:fs';
import { aws } from './lib/aws.mjs';
import { args, isMain, main, setOutput } from './lib/cli.mjs';
import { imageRefs } from './lib/manifest-check.mjs';

export function pickRevision(arns, describe, wantImage) {
  const hits = arns.filter((arn) =>
    describe(arn).containerDefinitions.some((c) => c.image === wantImage),
  );
  if (hits.length !== 1)
    throw new Error(
      `${hits.length} active task-definition revisions use ${wantImage}; exactly one is required. ` +
        'The task definitions for this manifest are registered by a platform-admin apply of the approvals root; ' +
        'this workflow waits (stops) until they exist and never registers them.',
    );
  return hits[0];
}

if (isMain(import.meta.url))
  main(() => {
    const argv = process.argv.slice(2);
    const families = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--family') {
        const [k, v] = (argv[++i] ?? '').split('=');
        if (!k || !v) throw new Error('--family needs name=family');
        families[k] = v;
      } else rest.push(argv[i]);
    }
    const a = args(rest, {
      manifest: 'required',
      'migration-arn': 'optional',
      'migration-image': 'optional',
    });
    const refs = imageRefs(JSON.parse(readFileSync(a.manifest, 'utf8')));
    const describe = (arn) =>
      aws(['ecs', 'describe-task-definition', '--task-definition', arn]).taskDefinition;
    for (const [name, family] of Object.entries(families)) {
      if (!refs[name]) throw new Error(`manifest has no required image "${name}"`);
      const arns = aws([
        'ecs',
        'list-task-definitions',
        '--family-prefix',
        family,
        '--status',
        'ACTIVE',
      ]).taskDefinitionArns.filter((x) => x.split('/').pop().split(':')[0] === family);
      setOutput(`taskdef_${name}`, pickRevision(arns, describe, refs[name]));
    }
    if (a['migration-arn']) {
      // Pinned by ARN in environment configuration (DPR-39); it must run the same digest as the release (8.1 rule 3).
      const want = refs[a['migration-image'] ?? 'api'];
      const td = describe(a['migration-arn']);
      if (!td.containerDefinitions.some((c) => c.image === want))
        throw new Error(`migration task definition ${a['migration-arn']} does not run ${want}`);
      if (td.containerDefinitions.length !== 1)
        throw new Error('migration task definition must have exactly one container');
      setOutput('taskdef_migration', a['migration-arn']);
    }
  });
