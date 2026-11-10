#!/usr/bin/env node
// Post-run verdicts for TC-REC-04 / TC-REC-07 (rec-continuity.js). Inputs: the raw k6 `--out json=` file, the k6 log with `ACK` lines,
// and read-only SQL to prove every acknowledged write is still there exactly once.
// usage: node check-recovery.mjs --case TC-REC-07 --points raw.json --log console.txt (the k6 console output, where ACK lines go) --since ISO-start-of-run --out report.json (needs LOADTEST_RO_DATABASE_URL)
import fs from 'node:fs';
import readline from 'node:readline';
import { query } from './lib/psql.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const CASE = arg('case');
const MAX = Number(arg('max-window-s', process.env.MAX_ERROR_WINDOW_S || 120));
const GAP = 5; // seconds of quiet that end a failure window
const findings = [];

// 1. failure windows from raw points of the rec_failed_requests counter
const fails = [];
let lastPoint = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(arg('points')) })) {
  if (!line.includes('"type":"Point"')) continue; // key order differs between k6 versions
  const p = JSON.parse(line);
  if (p.type !== 'Point') continue;
  const t = Date.parse(p.data.time) / 1000;
  if (t > lastPoint) lastPoint = t;
  if (p.metric === 'rec_failed_requests') fails.push(t);
}
fails.sort((a, b) => a - b);
const windows = [];
for (const t of fails) {
  const w = windows[windows.length - 1];
  if (w && t - w.end <= GAP) w.end = t;
  else windows.push({ start: t, end: t });
}
const longest = Math.max(0, ...windows.map((w) => w.end - w.start + 1));
const stillFailing = windows.length > 0 && lastPoint - windows[windows.length - 1].end < 30;
if (CASE === 'TC-REC-04' && fails.length)
  findings.push(
    `TC-REC-04 requires zero downtime: ${fails.length} failed requests in ${windows.length} window(s)`,
  );
if (CASE === 'TC-REC-07') {
  if (windows.length === 0)
    findings.push(
      'no failure observed: the primary was not disrupted during the run, so the case is not exercised',
    );
  if (longest > MAX) findings.push(`longest error window ${longest}s exceeds ${MAX}s`);
  if (stillFailing)
    findings.push('requests were still failing in the last 30 s of the run (no recovery observed)');
}

// 2. no committed data lost: every ACKed marker is present exactly once
const acks = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(arg('log')) })) {
  const m = / ACK (\S+) (rec-\S+)/.exec(line) || /ACK (\S+) (rec-\S+)/.exec(line);
  if (m) acks.push({ enc: m[1], marker: m[2].replace(/["'\\]+$/, '') });
}
// the notes carry a unique marker in their JSON body; count each marker exactly (read-only SQL, see lib/psql.mjs)
const rows = query(
  `select body::text from clinical.note where created_at >= '${arg('since')}'::timestamptz and body::text like '%rec-${CASE}-%'`,
);
const seen = new Map();
for (const [body] of rows)
  for (const m of body.matchAll(/rec-TC-REC-0[47]-[0-9a-f-]{36}/g))
    seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
let missing = 0;
let duplicated = 0;
for (const a of acks) {
  const n = seen.get(a.marker) ?? 0;
  if (n === 0) missing++;
  else if (n > 1) duplicated++;
}
if (acks.length === 0) findings.push('no acknowledged writes in the log: nothing to verify');
if (missing) findings.push(`${missing} acknowledged write(s) are missing (committed data lost)`);
if (duplicated)
  findings.push(`${duplicated} acknowledged write(s) appear more than once (duplicate effect)`);

const result = {
  case: CASE,
  acknowledgedWrites: acks.length,
  failedRequests: fails.length,
  windows: windows.length,
  longestWindowS: longest,
  missing,
  duplicated,
  findings,
  pass: findings.length === 0,
};
fs.writeFileSync(arg('out', `${CASE}.recovery.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(result.pass ? 0 : 1);
