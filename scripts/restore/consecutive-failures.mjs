#!/usr/bin/env node
// "Two consecutive failures stop releases until fixed" (DEVOPS-PLAN 10.3 step 6). Reads `gh run list --json` output of the
// scheduled restore-test runs, newest first, and exits non-zero when the last two completed runs both failed. Release
// workflows and the Release Reviewer read this; the restore-test workflow prints it so the signal exists in the run.
//   gh run list --workflow restore-test.yml --status completed --limit 6 --json conclusion,createdAt,event | consecutive-failures.mjs
import { readFileSync } from 'node:fs';
import { isMain, main } from '../deploy/lib/cli.mjs';

export function consecutiveFailures(runs, { event = 'schedule' } = {}) {
  const done = runs
    .filter(
      (r) =>
        r.event === event &&
        ['success', 'failure', 'timed_out', 'cancelled'].includes(r.conclusion),
    )
    .filter((r) => r.conclusion !== 'cancelled')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let n = 0;
  for (const r of done) {
    if (r.conclusion === 'success') break;
    n += 1;
  }
  return { consecutive: n, stopReleases: n >= 2, examined: done.length };
}

if (isMain(import.meta.url))
  main(() => {
    const r = consecutiveFailures(JSON.parse(readFileSync(0, 'utf8')));
    console.log(
      `restore-test: ${r.consecutive} consecutive failed scheduled run(s) of ${r.examined} examined`,
    );
    if (r.stopReleases)
      throw new Error(
        'two consecutive restore tests failed: releases stop until the restore test passes again (10.3 step 6)',
      );
  });
