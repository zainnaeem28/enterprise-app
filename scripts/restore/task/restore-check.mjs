#!/usr/bin/env node
// Entry point of the pinned restore task (DEVOPS-PLAN 10.3). Fixed entry point, no arguments: the task definition (created
// by the human-applied approvals root) sets only non-secret configuration; the target is found by tag.
//
// NOT YET RUNNABLE IN AN IMAGE. It needs `pg` (already in the workspace), `@aws-sdk/client-rds` and `@aws-sdk/client-s3`
// (not yet workspace dependencies), the RDS CA bundle, and a place in the pinned image: scripts/restore/task/, db/tools/
// and package.json for these. Those are lockfile- and Dockerfile-owner changes requested through the Orchestrator
// (scripts/restore/README.md, "Requests"). The orchestration is tested with injected dependencies (test/task.test.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runRestoreCheck } from './run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};
const load = async (name) => {
  try {
    return await import(name);
  } catch {
    throw new Error(`${name} is not installed in this image`);
  }
};

const region = env('AWS_REGION');
const bucket = env('RESTORE_RESULT_BUCKET');
const imageDigest = env('RESTORE_IMAGE_DIGEST'); // the task definition sets the digest it was pinned with
const caFile = env('RDS_CA_BUNDLE');

const { RDSClient, DescribeDBInstancesCommand, ModifyDBInstanceCommand, waitUntilDBInstanceAvailable } = await load('@aws-sdk/client-rds');
const { S3Client, PutObjectCommand, GetObjectCommand } = await load('@aws-sdk/client-s3');
const pg = (await load('pg')).default;
const rdsc = new RDSClient({ region });
const s3 = new S3Client({ region });

const describe = async (id) => (await rdsc.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))).DBInstances[0];

const deps = {
  now: () => Date.now(),
  log: (m) => console.log(m),
  imageDigest,
  tables: JSON.parse(readFileSync(join(here, 'tables.json'), 'utf8')),
  async findTarget() {
    const all = (await rdsc.send(new DescribeDBInstancesCommand({}))).DBInstances.filter((i) => (i.TagList ?? []).some((t) => t.Key === 'purpose' && t.Value === 'restore-test'));
    if (all.length !== 1) throw new Error(`expected exactly one restore-test instance, found ${all.length}`);
    const i = all[0];
    if (i.DBInstanceStatus !== 'available') throw new Error('restore target is not available');
    return { id: i.DBInstanceIdentifier, host: i.Endpoint.Address, port: i.Endpoint.Port, database: i.DBName ?? 'postgres', masterUsername: i.MasterUsername, tags: Object.fromEntries(i.TagList.map((t) => [t.Key, t.Value])) };
  },
  rds: {
    async resetMaster(id, password) {
      await rdsc.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: id, MasterUserPassword: password, EnableIAMDatabaseAuthentication: false, ApplyImmediately: true }));
      await waitUntilDBInstanceAvailable({ client: rdsc, maxWaitTime: 1800 }, { DBInstanceIdentifier: id });
    },
    async iamAuthEnabled(id) {
      return (await describe(id)).IAMDatabaseAuthenticationEnabled === true;
    },
  },
  async connect(target, user, password) {
    const client = new pg.Client({ host: target.host, port: target.port, database: target.database, user, password, application_name: 'restore-check', ssl: { rejectUnauthorized: true, ca: readFileSync(caFile, 'utf8') } });
    await client.connect();
    return { query: (sql, params) => client.query(sql, params), end: () => client.end() };
  },
  async runCatalogChecks(db) {
    return (await import(join(here, '..', '..', '..', 'db', 'tools', 'catalog-check.mjs'))).runChecks(db);
  },
  auditVerifier: process.env.AUDIT_VERIFIER_MODULE ? await load(process.env.AUDIT_VERIFIER_MODULE) : null,
  async baseline() {
    try {
      const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'restore-test/baseline/latest.json' }));
      return JSON.parse(await o.Body.transformToString());
    } catch {
      return null; // reported as `partial: baseline_unavailable`, never as a pass
    }
  },
  async putResult(doc) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `restore-test/results/${doc.run_id}.json`, Body: `${JSON.stringify(doc)}\n`, ContentType: 'application/json', ServerSideEncryption: 'aws:kms' }));
  },
};

try {
  await runRestoreCheck(deps);
} catch (e) {
  console.error(`restore check failed before a result could be written (${e?.code ?? e?.name ?? 'Error'})`);
  process.exitCode = 1;
}
