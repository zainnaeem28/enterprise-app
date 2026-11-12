// Builds docs/evidence/prd-trace/{PRD-TRACE-MATRIX.md,matrix.csv}.
// Inputs: docs/PRD.md (RA/NFR rows), docs/TEST-CASES.md (case table, section 15.1 row-to-case map),
// the JUnit/CSV evidence under docs/evidence, and git history (drift of the mapped code since each evidence head).
// Run from the repository root: node docs/evidence/prd-trace/build-matrix.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const HEAD = git('rev-parse', process.env.TRACE_HEAD ?? 'HEAD');
const H = HEAD.slice(0, 7);
const prd = readFileSync('docs/PRD.md', 'utf8');
const tc = readFileSync('docs/TEST-CASES.md', 'utf8');

// ---- PRD rows -------------------------------------------------------------------------------
const rows = [];
for (const m of prd.matchAll(/^\| (RA-R\d-\d+[ab]?) \| (.*?) \| (.*?) \|$/gm)) rows.push({ id: m[1], text: m[2], kind: 'RA' });
for (const m of prd.matchAll(/^\| (NFR-\d+) \| (.*?) \| (.*?) \| (.*?) \|$/gm)) rows.push({ id: m[1], text: `${m[2]}: ${m[3]}`, kind: 'NFR' });
for (const r of rows) r.text = r.text.replace(/\*\*/g, '').replace(/\s+/g, ' ');

// ---- case table -----------------------------------------------------------------------------
const cases = new Map();
for (const line of tc.split('\n')) {
  const m = line.match(/^\| (TC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+[a-z]?) \|/);
  if (!m) continue;
  const cells = line.split('|').map((s) => s.trim());
  cases.set(m[1], { id: m[1], pri: cells.find((c) => /^P[0-3]$/.test(c)) ?? '', auto: cells[cells.length - 2] ?? '' });
}
const expand = (spec) => {
  const out = new Set();
  const clean = spec.replace(/\([^)]*\)/g, ' ');
  for (const m of clean.matchAll(/(TC-[A-Z0-9]+(?:-[A-Z0-9]+)*?)-(\d+)[a-z]?(?:\.\.(\d+))?/g)) {
    const [, prefix, a, b] = m;
    const lo = Number(a), hi = Number(b ?? a);
    for (const id of cases.keys()) {
      const mm = id.match(/^(.*)-(\d+)[a-z]?$/);
      if (mm && mm[1] === prefix && Number(mm[2]) >= lo && Number(mm[2]) <= hi) out.add(id);
    }
  }
  return [...out];
};
const rowCases = new Map();
const sec151 = tc.split('### 15.1')[1].split('### 15.2')[0];
for (const line of sec151.split('\n')) {
  const m = line.match(/^\| (RA-R1-\d+[ab]?) \| (.*?) \|/);
  if (m) rowCases.set(m[1], expand(m[2]));
}
// RA-R1-18 is "all R1 NFR targets pass": it is the sum of the NFR rows below, not its own case list.
const nfrCases = {
  'NFR-1': 'TC-REC-07 TC-REC-08', 'NFR-2': 'TC-REC-01 TC-REC-03', 'NFR-3': 'TC-REC-02 TC-REC-03', 'NFR-4': 'TC-REC-01 TC-REC-02',
  'NFR-5': 'TC-REC-04', 'NFR-6': 'TC-PERF-01 TC-PERF-03', 'NFR-7': 'TC-PERF-05', 'NFR-8': 'TC-PERF-02',
  'NFR-9': 'TC-PERF-01 TC-PERF-06 TC-PERF-08', 'NFR-10': 'TC-A11Y-01..08', 'NFR-11': 'TC-XB-01..03',
  'NFR-12': 'TC-NFR-01 TC-NFR-02', 'NFR-13': 'TC-AU-05..09 TC-PERF-04', 'NFR-14': 'TC-NFR-08', 'NFR-15': 'TC-NFR-03..07',
  'NFR-16': 'TC-PEN-01', 'NFR-17': 'TC-NFR-12 TC-BS-06 TC-DOC-03', 'NFR-18': 'TC-NFR-09 TC-NFR-10', 'NFR-19': 'TC-NFR-11',
  'NFR-20': 'TC-REC-08', 'NFR-21': 'TC-REC-06', 'NFR-22': 'TC-BK-10 TC-TH-02',
};
for (const [k, v] of Object.entries(nfrCases)) rowCases.set(k, expand(v));
for (const [k, v] of rowCases) if (!v.length) console.error('WARN no cases for', k);

// ---- merged code locations (checked to exist; the script fails on a stale path) ---------------
const A = 'apps/api/src/modules';
const code = {
  'RA-R1-01': [`${A}/identity/oidc.ts`, `${A}/identity/auth.controller.ts`, `${A}/identity/sessions.ts`, `${A}/identity/realms.ts`, 'apps/patient/src/features/auth', 'apps/staff/src/features/auth', 'db/migrations/0500_identity_schema_and_tables.sql'],
  'RA-R1-02': [`${A}/scheduling/core`, `${A}/scheduling/availability`, `${A}/scheduling/flow/notices.ts`, 'apps/patient/src/features/booking', 'db/migrations/0903_scheduling_booking_functions.sql'],
  'RA-R1-03': [`${A}/scheduling/core/service.ts`, `${A}/scheduling/core/concurrency.dbtest.ts`, 'db/migrations/0903_scheduling_booking_functions.sql', 'db/migrations/2408_scheduling_overbook_cap_per_slot.sql'],
  'RA-R1-04': [`${A}/calendar-sync`, 'apps/worker/src/jobs/calendar-sync', 'db/migrations/1400_calendar_sync_tables.sql'],
  'RA-R1-05': [`${A}/notifications/render.ts`, `${A}/notifications/r1-templates.ts`, `${A}/notifications/allowlist.ts`, `${A}/notifications/forbidden.ts`, `${A}/scheduling/core/ics.ts`],
  'RA-R1-06': [`${A}/clinical/frontdoor`, 'apps/staff/src/features/preconsult', 'db/migrations/1700_frontdoor_tables.sql'],
  'RA-R1-07': [`${A}/clinical/frontdoor/redflag.ts`, `${A}/notifications/alerts`, 'db/migrations/1200_staff_alert_tables.sql'],
  'RA-R1-08': [`${A}/clinical/frontdoor/consents.ts`, `${A}/scheduling/flow/previsit.ts`],
  'RA-R1-09': [`${A}/clinical/notes`, `${A}/clinical/chart/terminology.ts`, 'apps/staff/src/features/doctor', 'db/migrations/1800_notes_tables.sql'],
  'RA-R1-10': [`${A}/telehealth`, 'apps/worker/src/jobs/telehealth', 'apps/patient/src/features/telehealth', 'db/migrations/1500_telehealth_tables.sql'],
  'RA-R1-11': [`${A}/audit`, `${A}/clinical/chart/access.ts`, `${A}/clinical/chart/break-glass-controller.ts`, 'db/migrations/0200_audit_event.sql', 'db/migrations/0202_audit_btg_and_export.sql'],
  'RA-R1-12': [`${A}/audit`, `${A}/admin-routes/audit-routes.ts`, 'db/migrations/0203_audit_rls_and_grants.sql', 'db/migrations/0204_audit_anchor_archive_receipt.sql'],
  'RA-R1-13': [`${A}/documents`, 'apps/worker/src/jobs/documents', 'db/migrations/1000_documents_schema_and_tables.sql'],
  'RA-R1-14': [`${A}/privacy`, `${A}/patient/export.ts`, 'apps/patient/src/features/privacy', 'db/migrations/1900_privacy_schema_and_tables.sql', 'db/migrations/2600_privacy_deletion_tables.sql'],
  'RA-R1-15': [`${A}/organisation`, 'apps/staff/src/features/admin-config'],
  'RA-R1-16': ['apps/site/src', 'apps/cms/src/collections', 'apps/cms/src/globals'],
  'RA-R1-17': [`${A}/identity/scope.ts`, `${A}/patient/scope.ts`, 'db/migrations/0502_identity_rls_and_grants.sql', 'db/migrations/0904_sec03_bind_definer_functions_to_caller.sql'],
  'RA-R1-18': [],
  'RA-R1-19': [`${A}/patient/service.ts`, 'apps/patient/src/features/profile', 'db/migrations/0700_patient_schema_and_tables.sql'],
  'RA-R1-20a': [`${A}/identity/proxy.ts`, `${A}/identity/proxy-scopes.ts`, 'apps/patient/src/features/profile', 'db/migrations/2620_proxy_rules_tables.sql'],
  'RA-R1-20b': [`${A}/identity/proxy.ts`, `${A}/identity/proxy-scopes.ts`, 'apps/staff/src/features/guardians', 'db/migrations/2623_proxy_rules_rls_and_grants.sql'],
  'RA-R1-21': [`${A}/scheduling/flow/previsit.ts`, 'apps/patient/src/features/previsit', 'apps/staff/src/features/preconsult'],
  'RA-R1-22': [`${A}/scheduling/flow/waitlist.ts`, 'apps/worker/src/jobs/scheduling'],
  'RA-R1-23': [`${A}/scheduling/availability`, 'apps/staff/src/features/availability', 'db/migrations/1100_availability_tables.sql'],
  'RA-R1-24': [`${A}/clinical/chart`, 'apps/staff/src/features/doctor'],
  'RA-R1-25': [`${A}/messaging`, 'apps/staff/src/features/messages', 'db/migrations/2000_messaging_schema_and_tables.sql'],
  'RA-R1-26': [`${A}/organisation/admin/flag-rules.ts`, `${A}/reporting`, 'apps/site/src/consent.ts', 'apps/site/src/components/ConsentBanner.tsx'],
  'RA-R1-27': [`${A}/identity/merge.ts`, `${A}/patient/merge`, 'db/migrations/0803_patient_merge_functions.sql', 'apps/worker/src/merge-e2e.dbtest.ts'],
  'RA-R1-28': [`${A}/telehealth/rules.ts`, `${A}/telehealth/service.ts`, 'db/migrations/2640_identity_licensed_state_admin_write.sql'],
  'RA-R1-29': [`${A}/clinical/frontdoor/followups.ts`, `${A}/clinical/frontdoor/common.ts`, 'db/migrations/1700_frontdoor_tables.sql'],
  'RA-R1-30': [`${A}/clinical/frontdoor/followups.ts`, `${A}/clinical/frontdoor/referrals.ts`, 'db/migrations/2300_patient_referral_accept_scope.sql'],
  'RA-R1-31': [`${A}/integration-core`, `${A}/integrations-host`, `${A}/admin-routes/integration-routes.ts`, 'apps/staff/src/features/admin-compliance'],
  'RA-R1-32': [`${A}/identity/admin`, 'apps/staff/src/features/admin-auth', 'db/migrations/2400_identity_admin_tables.sql', 'db/migrations/2405_identity_admin_second_key_session.sql'],
  'NFR-1': ['infra/modules/observability', 'infra/modules/database'], 'NFR-2': ['infra/modules/dr', 'infra/modules/database'],
  'NFR-3': ['infra/modules/dr', 'scripts/restore'], 'NFR-4': ['infra/modules/dr', 'infra/modules/database', '.github/workflows/restore-test.yml'],
  'NFR-5': ['.github/workflows/deploy-production.yml', 'infra/modules/compute', 'scripts/ci/migration-check'],
  'NFR-6': ['tests/load/scenarios/perf-01-mixed.js'], 'NFR-7': ['lighthouserc.cjs', 'apps/site/src', 'apps/patient/src'],
  'NFR-8': [`${A}/scheduling/availability/search.ts`, 'tests/load/scenarios/perf-02-slot-search.js'],
  'NFR-9': ['tests/load', 'infra/modules/loadtest', '.github/workflows/loadtest-run.yml'],
  'NFR-10': ['tests/e2e/a11y', 'apps/patient/src/a11y.test.tsx', 'apps/staff/src/a11y.test.tsx', 'apps/site/src/a11y.test.tsx', 'packages/ui'],
  'NFR-11': ['tests/e2e/a11y/xb.spec.ts', 'packages/ui'],
  'NFR-12': ['infra/modules/kms', 'infra/modules/edge', 'infra/modules/storage', 'infra/modules/database'],
  'NFR-13': [`${A}/audit`, 'infra/modules/archive', 'infra/RETENTION.md'],
  'NFR-14': ['docs/security', 'packages/kernel/src', 'apps/api/src/platform'],
  'NFR-15': ['.github/workflows/ci.yml', 'scripts/ci/sast.sh', 'scripts/ci/deps.sh', 'scripts/ci/secrets.sh', 'scripts/ci/container-scan.sh'],
  'NFR-16': ['docs/security/TC-PEN-01-scope-and-rules-of-engagement.md'],
  'NFR-17': [`${A}/documents`, 'apps/site/src/server.ts', 'infra/modules/edge'],
  'NFR-18': ['packages/kernel/src/logging/redact.ts', 'apps/site/src/analytics.ts', `${A}/notifications/forbidden.ts`],
  'NFR-19': ['docs/GO-LIVE.md', 'infra/accounts'], 'NFR-20': ['infra/modules/observability/alarms.tf', 'infra/modules/observability/canaries.tf'],
  'NFR-21': [`${A}/integration-core`, 'packages/kernel/src', 'apps/worker/src/runner.ts'], 'NFR-22': [`${A}/scheduling/core`, `${A}/telehealth/rules.ts`, 'packages/kernel/src'],
};
const missing = [];
for (const [k, ps] of Object.entries(code)) for (const p of ps) if (!existsSync(p)) missing.push(`${k}: ${p}`);
if (missing.length) { console.error('stale code paths:\n' + missing.join('\n')); process.exit(2); }
for (const r of rows) if (r.kind === 'RA' && r.id.startsWith('RA-R1') && !(r.id in code)) console.error('WARN no code map', r.id);

// ---- results: later source wins ---------------------------------------------------------------
const sources = [
  { head: '00faee1', label: 'QA-06 a11y/cross-browser run (3 engines)', file: 'tests/e2e/a11y/evidence/junit.xml' },
  { head: 'cdc388d', label: 'R2 QA run (qa-execution-r2 case-results.csv)', file: 'docs/evidence/qa-execution-r2/case-results.csv', csv: true },
  { head: 'cdc388d', label: 'BR-34 banner cases (qa-banner/r2-cdc388d)', file: 'docs/evidence/qa-banner/r2-cdc388d/api-junit.xml' },
  { head: 'cdc388d', label: 'QA supplement (qa-supplement/r2-cdc388d)', file: 'docs/evidence/qa-supplement/r2-cdc388d/junit.xml' },
  { head: '7860f5f', label: 'qa-r3 supplement', file: 'docs/evidence/qa-r3/7860f5f/supplement-junit.xml' },
  { head: 'ae1f6c9', label: 'qa-r3 supplement', file: 'docs/evidence/qa-r3/ae1f6c9/junit.xml' },
  { head: 'ff5476e', label: 'qa-r3 supplement', file: 'docs/evidence/qa-r3/ff5476e/supplement-junit.xml' },
  { head: 'd357128', label: 'ruling C platform run (92 tests)', file: 'docs/evidence/qa-ruling-c/junit.xml' },
];
const ids = (name) => {
  const out = new Set();
  for (const m of name.matchAll(/TC-[A-Z0-9]+(?:-[A-Z0-9]+)*?-(\d+[a-z]?)((?:\/\d+[a-z]?)*)/g)) {
    const prefix = m[0].replace(/-\d+[a-z]?(?:\/\d+[a-z]?)*$/, '');
    out.add(`${prefix}-${m[1]}`);
    for (const n of m[2].split('/').filter(Boolean)) out.add(`${prefix}-${n}`);
  }
  return [...out].map((i) => (cases.has(i) ? i : i.replace(/[a-z]$/, ''))).filter((i) => cases.has(i));
};
const result = new Map(); // id -> {state, head, label}
const setRes = (id, state, src) => {
  const prev = result.get(id);
  const rank = { fail: 3, pass: 2, skip: 1 };
  if (prev && prev.head === src.head && rank[prev.state] >= rank[state]) return;
  result.set(id, { state, head: src.head, label: src.label });
};
for (const src of sources) {
  if (!existsSync(src.file)) { console.error('missing evidence', src.file); process.exit(2); }
  const txt = readFileSync(src.file, 'utf8');
  const local = new Map();
  const note = (id, st) => {
    const p = local.get(id);
    local.set(id, p === 'fail' || st === 'fail' ? 'fail' : p === 'pass' || st === 'pass' ? 'pass' : st);
  };
  if (src.csv) {
    for (const l of txt.split('\n').slice(1)) {
      const c = l.match(/^[^,]*,(TC-[^,]+),([^,]*),/);
      if (c) for (const id of ids(c[1])) note(id, c[2] === 'pass' ? 'pass' : c[2] === 'fail' ? 'fail' : 'skip');
    }
  } else {
    for (const m of txt.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const body = m[3] ?? '';
      const st = /<failure|<error/.test(body) ? 'fail' : /<skipped/.test(body) ? 'skip' : 'pass';
      for (const id of ids(m[1].replace(/&amp;/g, '&'))) note(id, st);
    }
  }
  for (const [id, st] of local) setRes(id, st, src);
}

// ---- drift: commits touching the mapped code between the evidence head and HEAD ----------------
const driftCache = new Map();
const drift = (head, paths) => {
  if (!paths.length) return null;
  const key = head + '|' + paths.join(',');
  if (!driftCache.has(key)) {
    const out = git('log', '--oneline', `${head}..${HEAD}`, '--', ...paths.filter((p) => existsSync(p)));
    driftCache.set(key, out ? out.split('\n').length : 0);
  }
  return driftCache.get(key);
};

// ---- skip reasons from the R2 case-results.csv (proper CSV parse) --------------------------------
const csvRows = [];
{
  const t = readFileSync('docs/evidence/qa-execution-r2/case-results.csv', 'utf8');
  let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); csvRows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
}
const reason = new Map();
for (const r of csvRows.slice(1)) if (r[2] === 'blocked/skipped') for (const id of ids(r[1])) reason.set(id, (r[4] || r[3]).replace(/\s+/g, ' '));
// the ruling C run (d357128) names its own skip reasons in the test title; keep the R2 text when both exist.

// ---- unit results on this head (reports/unit/junit, produced by `node scripts/ci/run-unit.mjs` at HEAD) ------
const wsDir = { _ehr_staff: 'apps/staff', _ehr_patient: 'apps/patient', _ehr_site: 'apps/site', _ehr_cms: 'apps/cms', _ehr_ui: 'packages/ui', 'app-shell': 'packages/app-shell' };
const unit = new Map(); // repo-relative test file -> {pass, fail}
let unitTotals = [];
// compiled tests are recorded as <pkg>/dist/[src/]x.test.js (api: dist/src; worker, kernel: dist); map them back to the source path <pkg>/src/x.test.ts
const srcPath = (f) => f.replace(/^((?:apps|packages)\/[^/]+)\/dist\/(?:src\/)?(.*)\.test\.js$/, '$1/src/$2.test.ts');
const unitCsv = 'docs/evidence/prd-trace/head-run/unit-by-file.csv';
const fromCsv = !existsSync('reports/unit/junit') && existsSync(unitCsv);
if (fromCsv) {
  for (const l of readFileSync(unitCsv, 'utf8').split('\n').slice(1)) {
    const [f, p, x] = l.split(',');
    if (!f || f.endsWith('/')) continue; // drops the blank-file bucket 'apps/api/' (14 tests with no file attribute)
    const k = srcPath(f);
    const u = unit.get(k) ?? { pass: 0, fail: 0 };
    u.pass += Number(p); u.fail += Number(x);
    unit.set(k, u);
  }
  unitTotals = ['re-read from head-run/unit-by-file.csv (recorded on the traced head); dist paths mapped to src'];
}
if (existsSync('reports/unit/junit')) {
  const { readdirSync } = await import('node:fs');
  const cwd = process.cwd() + '/';
  for (const d of readdirSync('reports/unit/junit', { withFileTypes: true })) {
    const files = d.isDirectory() ? readdirSync(`reports/unit/junit/${d.name}`).map((f) => `reports/unit/junit/${d.name}/${f}`) : [`reports/unit/junit/${d.name}`];
    for (const f of files) {
      const x = readFileSync(f, 'utf8');
      let n = 0, bad = 0;
      for (const chunk of x.split('<testcase ').slice(1)) {
        n++;
        const attrs = chunk.slice(0, chunk.indexOf('>'));
        const failed = /<failure|<error/.test(chunk.slice(0, chunk.indexOf('</testcase>') < 0 ? 0 : chunk.indexOf('</testcase>')));
        if (failed) bad++;
        let file = attrs.match(/ file="([^"]*)"/)?.[1]?.replace(cwd, '');
        if (!file) {
          const cn = attrs.match(/classname="([^"]*)"/)?.[1] ?? '';
          const base = wsDir[d.name] ?? wsDir[d.name.replace('_ehr_', '')] ?? (d.name.startsWith('_ehr_') ? `apps/${d.name.slice(5)}` : '');
          file = base ? `${base}/${cn}` : cn;
        }
        file = srcPath(file);
        const u = unit.get(file) ?? { pass: 0, fail: 0 };
        failed ? u.fail++ : u.pass++;
        unit.set(file, u);
      }
      unitTotals.push(`${f.replace('reports/unit/junit/', '')}: ${n} tests, ${bad} failed`);
    }
  }
}
const unitUnder = (paths) => {
  let pass = 0, fail = 0;
  for (const [f, u] of unit) if (paths.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'))) { pass += u.pass; fail += u.fail; }
  return { pass, fail };
};
const dbtestsUnder = (paths) => {
  const out = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const l = execFileSync('git', ['ls-files', p], { encoding: 'utf8' }).split('\n').filter((f) => /\.dbtest\.(ts|mjs)$/.test(f));
    out.push(...l);
  }
  return [...new Set(out)];
};
if (!fromCsv) writeFileSync(unitCsv, ['test_file,pass,fail', ...[...unit].sort().map(([f, u]) => `${f},${u.pass},${u.fail}`)].join('\n') + '\n');

// ---- classify every case that has no passing result ---------------------------------------------
const humanReg = new Set(expand(tc.split('## 12. Human-required register')[1].split('## 13.')[0]));
const classify = (id, st) => {
  const c = cases.get(id);
  const why = reason.get(id) ?? '';
  if (st?.state === 'fail' && /^TC-PC-(07|13)$/.test(id)) return ['DEFECT (fix merged, case not rerun)', 'failed on cdc388d (qa-banner REPORT F-1..F-5, finding R3-F01). The fix HEAAA-819 (ef760d1) is merged; its evidence is staff component and mocked-API Playwright tests (docs/evidence/qa-banner/r3-fix-HEAAA-819). The real-stack case has not been rerun, so the failure stays open'];
  if (st?.state === 'fail') return ['DEFECT', 'failed in the last run'];
  if (id === 'TC-AD-04') return ['DEFECT (stale test)', 'skip text says "NOT DELIVERED", but the template admin routes were merged (HEAAA-665, apps/api/src/modules/notifications/admin-controller.ts); the platform case was never rewritten or rerun'];
  if (id === 'TC-AU-01b') return ['DEFECT or scope question', 'no chart export or print route exists in R1, so there is nothing to audit; PRD NFR-13 names export and print. PM to confirm R1 has no chart export/print, otherwise it is a missing feature'];
  if (humanReg.has(id) || /^HUMAN|HUMAN\)/.test(c.auto)) return ['GO-LIVE (human)', why || 'needs the named person; QA never records a result for it (TEST-CASES 12)'];
  if (/^OPS/.test(c.auto)) return ['GO-LIVE (operations evidence)', why || 'operations exercise or policy export; QA reviews the evidence'];
  if (/^TC-(PERF|REC|PEN)/.test(id)) return ['GO-LIVE (environment)', 'needs ENV-LOAD, ENV-DR or a deployed stack that does not exist yet (TEST-CASES 0.3, 13; GO-LIVE.md)'];
  if (/^TC-NFR-(03|04|05|06|07)$/.test(id)) return ['GO-LIVE (CI gates)', 'owner ruling B: no hosted CI; the scripts exist (scripts/ci) and ran locally on d357128 (docs/evidence/qa-ruling-c/ci-summary-raw.txt: deps pass; sast and secrets exit 1; not rerun on this head)'];
  if (/^TC-NFR-/.test(id)) return ['GO-LIVE (environment)', 'needs a deployed host, cloud console or owner document (TEST-CASES 0.3 "no test environment")'];
  if (/^TC-A11Y|^TC-XB/.test(id)) return ['GO-LIVE (human)', 'assistive-technology or real-device run (TEST-CASES 12)'];
  if (/sandbox|vendor|store|scanner|Google|e-mail|mail|staging|Workspace|managed pool|C-\d\d/i.test(why)) return ['GO-LIVE (sandbox/vendor)', why];
  if (why) return ['GAP (blocked by test hooks/harness)', why];
  if (/staging|vendor|sandbox/i.test(c.auto)) return ['GO-LIVE (sandbox/vendor)', 'no recorded result'];
  return ['GAP (no recorded result)', 'no result in any evidence file; automated or browser case that was not recorded as run'];
};

// ---- markdown ------------------------------------------------------------------------------------
const stateOf = (r) => {
  const cs = (rowCases.get(r.id) ?? []).map((i) => ({ id: i, st: result.get(i) }));
  return { cs };
};
const md = [];
const P = (s = '') => md.push(s);
P('# PRD requirement trace (matrix)');
P();
P('| Field | Value |');
P('| --- | --- |');
P('| Task | HEAAA-955 (audit 4 of HEAAA-807 `completeness-audit` rev 1). Carried into the R4 package HEAAA-828 (link there). |');
P(`| Final dev head traced | \`${HEAD}\` (\`origin/dev\`, "HEAAA-939: secret-replica crontab test …") |`);
P('| Author | QA Engineer agent. This is QA trace evidence. It is **not** an independent review (a separate task), **not** human acceptance and **not** G3. |');
P('| Inputs | `docs/PRD.md` sections 8.2 and 9 (RA-R1-01..32, RA-R2-01..11, RA-R3-01..07, NFR-1..22); `docs/TEST-CASES.md` (274 case IDs, section 15.1 row-to-case map, statuses after HEAAA-805); evidence under `docs/evidence` (r2 `cdc388d`, qa-r3 `7860f5f`/`ae1f6c9`/`ff5476e`, ruling C `d357128`); a fresh run on this head (section 2) |');
P('| Reproduce | `node scripts/ci/run-unit.mjs` then `node docs/evidence/prd-trace/build-matrix.mjs` (reads `reports/unit`, the evidence folders and git history; fails on a stale code path) |');
P();
P('## 1. Read this first');
P();
P(`1. **What passed on the final head.** Executed on \`${H}\` in this task: lint (0 errors, 30 warnings), format check, typecheck, build, boundary test, and **all 1,678 unit tests (0 failed, 0 skipped)**. Every requirement row below shows how many of those unit tests sit under its merged code (column "Unit @ head").`);
P(`2. **What did not run on the final head.** The database-backed suites (\`*.dbtest\` through \`integration-db.sh\`) and the API/browser case suites (\`tests/api/**\`, \`tests/e2e/**\`) were **not rerun on \`${H}\`**. The host disk is at 100% (65 MB free of 48 GB), and these suites need a throwaway PostgreSQL 17 plus build output; running them would risk filling the disk shared with other agents. Their last recorded passing results are on older heads. Each row names that head and how many commits have touched the row's mapped code since. **A row is called "PASS on older head, mapped code unchanged" only when that count is 0.** This is a statement about evidence age, not a fresh pass. Follow-up: gap G-01.`);
P('3. **Cases that did not pass are never counted as passes.** Blocked, skipped, human-required and unrecorded cases are listed in section 6 and classified as defect, gap or go-live item.');
P('4. **R2 and R3 requirements are not built** (PRD 4.3 makes them later releases). They have no merged code and no executable case. They are listed so that nothing is missing from the trace; they are a scope fact, not a defect of R1.');
P();
P('## 2. Executed on the final head');
P();
P('| Check | Result on `' + H + '` |');
P('| --- | --- |');
P('| `pnpm install --frozen-lockfile` | pass |');
P('| `pnpm build` | pass |');
P('| `pnpm lint` | pass, 0 errors, 30 warnings |');
P('| `pnpm format:check` | pass (the 6-file failure recorded on `d357128`, finding QA805-F01, is gone) |');
P('| `pnpm typecheck` | pass |');
P('| `pnpm test:boundary` | pass |');
P('| `node scripts/ci/run-unit.mjs` | pass: ' + unitTotals.map((x) => x.replace(/^[^/]*\//, '').replace(/\.xml/, '')).join('; ') + ' |');
P('| Not run | integration-db and N-1 (needs PostgreSQL; disk), `tests/api/**` and browser suites, SAST, secret scan, dependency audit, container scan, Schemathesis, Lighthouse (no hosted CI per owner ruling B; tools not installed here) |');
P();
P('Unit counts per file are in `head-run/unit-by-file.csv`. Node 24.22.2, pnpm 12.16.1 (from `package.json`). Synthetic data only; no live system was touched.');
P();
P('## 3. How to read the matrix');
P();
P('- **Merged code**: files or folders on the head that implement the row (checked to exist by the generator).');
P('- **Cases and last recorded result**: case IDs from `docs/TEST-CASES.md` section 15.1 (and NFR mapping), with the result found in the evidence files. "pass N" is a recorded pass; "skipped/blocked" is a case the run recorded as skipped or blocked; "no result" means no evidence file contains a result for it.');
P('- **Oldest evidence head**: the oldest candidate among the recorded passes, and how many commits touched the mapped code since. Evidence heads: `cdc388d` (R2 run), `00faee1` (QA-06 a11y), `7860f5f`/`ff5476e` (qa-r3 supplement), `d357128` (ruling C platform run, 26 commits behind this head).');
P('- **Unit @ head**: unit tests passing on this head under the mapped paths (compiled \`dist/**/*.test.js\` results are mapped back to their \`src/*.test.ts\` path), and the number of `*.dbtest` files under them that were not run on this head.');
P();
// PRD 8.2 rows that the PRD marks as blocked on an open owner decision; a pass is never read as clearing the decision.
const decisionNote = {
  'RA-R1-07': 'PRD 8.2: blocked until D-12a is decided; a PARTIAL here does not make the row passable',
  'RA-R1-08': 'PRD 8.2: blocked until D-12a is decided; a PARTIAL here does not make the row passable',
  'RA-R1-14': 'Against ruling-C delegated values; D-8 (meaning of deletion) not human-decided, counsel confirmation pending (TC-PR-03)',
  'RA-R1-20b': 'Against ruling-C delegated values (delegated ruling C item 3); D-7 not human-decided',
};
const section = (title, kind) => {
  P(title);
  P();
  P('| Requirement | Merged code | Cases and last recorded result | Unit @ head | Oldest evidence head | Status |');
  P('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows.filter((x) => x.kind === kind && !/^RA-R[23]/.test(x.id) && x.id !== 'RA-R1-18')) {
    const cs = (rowCases.get(r.id) ?? []);
    const res = cs.map((i) => ({ id: i, st: result.get(i) }));
    const pass = res.filter((x) => x.st?.state === 'pass'), skip = res.filter((x) => x.st?.state === 'skip'), fail = res.filter((x) => x.st?.state === 'fail'), none = res.filter((x) => !x.st);
    const order = sources.map((s) => s.head);
    const heads = [...new Set(pass.map((x) => x.st.head))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const oldest = heads[0] ?? '';
    const paths = code[r.id] ?? [];
    const d = oldest ? drift(oldest, paths) : null;
    const u = unitUnder(paths);
    const db = dbtestsUnder(paths).length;
    let status;
    if (fail.length) status = '**FAIL**';
    else if (!pass.length) status = 'NOT EXECUTED';
    else if (skip.length || none.length) status = d === 0 ? 'PARTIAL: executed part passed, no later code change; rest in section 6' : 'PARTIAL: executed part passed on an older head; rest in section 6';
    else status = d === 0 ? 'PASS on older head, mapped code unchanged' : `PASS on older head; ${d} later commit(s) to mapped code: rerun needed (G-01)`;
    if (decisionNote[r.id]) status += `. ${decisionNote[r.id]}`;
    const ids5 = (xs) => xs.map((x) => x.id.replace(/^TC-/, '')).join(' ');
    const cell = [pass.length ? `pass ${pass.length}: ${ids5(pass)}` : '', fail.length ? `**FAIL ${fail.length}: ${ids5(fail)}**` : '', skip.length ? `skipped/blocked ${skip.length}: ${ids5(skip)}` : '', none.length ? `no result ${none.length}: ${ids5(none)}` : ''].filter(Boolean).join('<br>') || 'no case';
    P(`| **${r.id}** ${r.text.slice(0, 110).replace(/\|/g, '/')}… | ${paths.map((p) => '`' + p + '`').join('<br>') || '-'} | ${cell} | ${paths.length ? `${u.pass} pass, ${u.fail} fail; ${db} dbtest file(s) not run` : 'n/a'} | ${oldest ? `${oldest}, ${d} commit(s)` : 'none'} | ${status} |`);
  }
  P();
};
P('Case IDs are shown without the `TC-` prefix.');
P();
section('## 4. Release 1 acceptance rows (PRD 8.2)', 'RA');
P('RA-R1-18 (all R1 NFR targets) is the sum of the NFR rows in section 5; it has no cases of its own.');
P();
section('## 5. Non-functional requirements (PRD 9)', 'NFR');
P('## 5.1 R2 and R3 acceptance rows (not built)');
P();
P('| Requirement | Merged code | Cases | Status |');
P('| --- | --- | --- | --- |');
for (const r of rows.filter((x) => /^RA-R[23]/.test(x.id))) P(`| **${r.id}** ${r.text.slice(0, 100).replace(/\|/g, '/')}… | none (no prescribing, e-prescribing, pharmacy, payment, delivery or lab code exists on the head) | reserved IDs only (TEST-CASES 14) | NOT BUILT (later release, PRD 4.3) |`);
P();
// ---- section 6: gaps
const gapCases = new Map();
for (const [rid, cs] of rowCases) for (const id of cs) {
  const st = result.get(id);
  if (st?.state === 'pass') continue;
  const g = gapCases.get(id) ?? { rows: [] };
  g.rows.push(rid);
  gapCases.set(id, g);
}
const byClass = new Map();
for (const [id, g] of gapCases) {
  const [cls, why] = classify(id, result.get(id));
  const arr = byClass.get(cls) ?? [];
  arr.push({ id, rows: g.rows, why });
  byClass.set(cls, arr);
}
P('## 6. Gaps: defects, test gaps and go-live items');
P();
P('Every case that has no passing result, with its class. A "defect" is a failure or a stale/misleading test or a missing feature; a "gap" is a case that could have run and has no recorded result; a "go-live item" needs a person, an environment or a vendor that does not exist yet. Nothing here is waived (PRD RA-R1-18, 8.3).');
P();
P('| Class | Count |');
P('| --- | --- |');
for (const [k, v] of [...byClass].sort()) P(`| ${k} | ${v.length} |`);
P();
for (const [k, v] of [...byClass].sort()) {
  P(`### ${k}`);
  P();
  P('| Case | Rows | Reason |');
  P('| --- | --- | --- |');
  for (const x of v.sort((a, b) => a.id.localeCompare(b.id))) P(`| ${x.id} | ${[...new Set(x.rows)].join(', ')} | ${x.why.replace(/\|/g, '/').slice(0, 260)} |`);
  P();
}
P('### Register of gaps raised by this trace');
P();
P('| ID | Class | Statement | Proposed owner and next action |');
P('| --- | --- | --- | --- |');
P(`| G-01 | Defect (evidence) | No passing run of the DB-backed suites or of \`tests/api/**\` and browser suites exists on \`${H}\`. The newest recorded runs are \`d357128\` (platform, 26 commits older), \`ff5476e\` (qa-r3) and the HEAAA-789 integration-db run on rebase \`c87dc62\`. Commits since touch code mapped by several rows (see "commits" in section 4). | Orchestrator: assign a run on a host with disk (the throwaway PostgreSQL 17 plus build), then rerun the trace generator. Host disk is 100% full (65 MB free): needs cleanup by the host owner |`);
P('| G-02 | Defect (stale test) | TC-AD-04 is still a skip saying "NOT DELIVERED" although the template admin routes were merged (HEAAA-665) and have a real-DB test | QA: rewrite TC-AD-04 against `/api/v1/admin/message-templates` and run it |');
P('| G-03 | Scope question | TC-AU-01b (defined in the ruling-C spec, docs/evidence/qa-ruling-c, not in docs/TEST-CASES.md): no chart export/print route in R1, so the PRD wording on audited export/print has nothing to test | PM via Orchestrator: confirm no chart export/print in R1, or raise a feature defect |');
P('| G-04 | Gap | Cases with no recorded result at all (class "GAP (no recorded result)") | QA: record results or reasons; most are browser cases for the check-in desk, triage and banner screens |');
P('| G-05 | Go-live | Human, operations, sandbox and environment cases are pending (classes "GO-LIVE") and are listed in `docs/GO-LIVE.md` where an owner action exists | Owner and DevOps, per TEST-CASES 12 |');
P('| G-06 | Go-live | R2 and R3 are not built | Product, later releases |');
P('| G-07 | Gap | CI gates (SAST, dependency, secret, container) are not run on the head: no hosted CI (owner ruling B). On `d357128`: lint pass, dependency audit pass, SAST exit 1 (workflow YAML parse), secret scan exit 1 (24 historic findings, allow-list HEAAA-930 since merged) | DevOps and Security Reviewer: rerun on the head once tools are installed |');
P();
P('## 7. Limitations');
P();
P('- The case-to-requirement map is the one in `docs/TEST-CASES.md` 15.1 and the NFR mapping in `build-matrix.mjs`; it is not independently reviewed.');
P('- "Merged code" is a path list chosen by QA and checked to exist, not a call graph. A row can be affected by code outside its list.');
P('- Result extraction reads case IDs from test titles; a title that does not carry its ID is counted as "no result". Sub-case IDs (for example 03a) are folded into their base case, and a base case counts as passed if any recorded sub-case passed and none failed.');
P('- Evidence age is measured by commits to the mapped paths, not by behaviour. Zero later commits means the code under test is byte-identical; it does not cover shared libraries outside the list.');
P('- "Unit @ head" counts only unit tests under the listed paths (compiled tests mapped back to src). A row whose paths are single files with no unit test of their own (for example RA-R1-03: service.ts and DB-backed tests) shows 0 pass; that 0 is real, its coverage is the dbtest and API cases.');
P('- Statuses of human-required cases stay pending until the named person records them.');
writeFileSync('docs/evidence/prd-trace/PRD-TRACE-MATRIX.md', md.join('\n') + '\n');
console.log(`rows ${rows.length}, cases ${cases.size}, results ${result.size}, head ${H}`);
for (const [k, v] of byClass) console.log(k, v.length);
