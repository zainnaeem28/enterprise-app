#!/usr/bin/env node
// Run the pinned audit-archive task once (ARCHITECTURE 6; DEVOPS-PLAN 4.2): as audit_archiver it exports the partition named by the
// approved record, reads the archive copy back, detaches and drops the partition, writes its own audit event in a short separate
// transaction and the manifest entry. The task has a fixed entryPoint and takes no arguments; RunTask carries NO overrides.
//   run-task.mjs --partition audit.event_YYYY_MM --out <result.json>
// Environment (no secrets): ARCHIVE_CLUSTER, ARCHIVE_TASK_DEFINITION_ARN, ARCHIVE_SUBNETS, ARCHIVE_SECURITY_GROUP,
// ARCHIVE_LOG_GROUP, ARCHIVE_LOG_STREAM_PREFIX, ARCHIVE_CONTAINER.
import { writeFileSync } from 'node:fs';
import { args, isMain, main, setOutput } from '../../deploy/lib/cli.mjs';
import { aws } from '../lib/aws.mjs';
import { runOnce, readLines } from '../run-task.mjs';
import { parseArchiveResult } from './result.mjs';

const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), { partition: 'required', out: 'required' });
    const cfg = {
      env: 'production',
      runId: need('GITHUB_RUN_ID'),
      cluster: need('ARCHIVE_CLUSTER'),
      taskDefinitionArn: need('ARCHIVE_TASK_DEFINITION_ARN'),
      subnets: need('ARCHIVE_SUBNETS').split(','),
      securityGroup: need('ARCHIVE_SECURITY_GROUP'),
      logGroup: need('ARCHIVE_LOG_GROUP'),
      logStreamPrefix: need('ARCHIVE_LOG_STREAM_PREFIX'),
      container: process.env.ARCHIVE_CONTAINER || 'audit-archive',
    };
    const call = (argv, scope) => aws(argv, { ...scope, record: 'audit-archive' });
    // runOnce names the started-by tag `gh-bootstrap-<run>`; the archive run is tagged by its own prefix here.
    const { taskId, exitCode, stoppedReason } = await runOnce(cfg, {
      call,
      startedByPrefix: 'gh-audit-archive',
      timeoutSeconds: 3300,
    });
    setOutput('task_id', taskId);
    if (exitCode !== 0)
      throw new Error(
        `audit-archive task ${taskId} exited with ${exitCode}${stoppedReason ? ` (${stoppedReason})` : ''}; the partition is dropped only after a verified read-back, so inspect the database and the archive before any retry`,
      );
    const r = parseArchiveResult(readLines(cfg, taskId, { call }), { partition: a.partition });
    writeFileSync(a.out, `${JSON.stringify(r, null, 2)}\n`);
    setOutput('rows', r.rowCount);
    setOutput('audit_event_id', r.auditEventId);
    console.log(
      `archived and dropped ${r.partition}: ${r.rowCount} rows, anchor roots ${r.anchorRootsSha256}, ${r.archiveKey}, manifest ${r.manifestEntry}`,
    );
  });
