// The PHI-free result document of a restore test (DEVOPS-PLAN 10.3 step 3, 10.2). The in-VPC task writes it; the workflow
// and QA read it. Nothing free-form can pass: every field is an integer, a boolean, a hex digest, or a value from a
// closed list, so a patient value cannot be carried even by a bug. Unknown keys are refused.

export const SCHEMA = 'ehr.restore-test-result/v1';
export const CHECK_IDS = [
  'credentials-reset',
  'schema-version',
  'catalogue-rls',
  'row-counts',
  'checksums',
  'audit-anchor-chain',
  'app-smoke-readonly',
];
export const STATUSES = ['pass', 'fail', 'partial'];
// Reason codes are a closed list, never an error message (messages can echo values).
export const REASON_CODES = [
  'none',
  'audit_schema_missing',
  'merkle_recompute_unavailable',
  'baseline_unavailable',
  'mutable_drift_exceeded',
  'immutable_mismatch',
  'catalogue_violation',
  'schema_hash_mismatch',
  'credentials_not_reset',
  'smoke_failed',
  'check_error',
];
const MODES = ['latest', 'pitr'];
const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^[a-z][a-z0-9_.]{0,62}$/; // table / catalogue-check identifiers from tables.json and catalog-check.mjs
const RUN_ID = /^[a-z0-9][a-z0-9-]{3,39}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;

function only(obj, allowed, where, errs) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errs.push(`${where} is not an object`);
    return false;
  }
  for (const k of Object.keys(obj))
    if (!allowed.includes(k)) errs.push(`${where}: unexpected key "${k}"`);
  return true;
}

function intMap(obj, where, errs) {
  if (!only(obj, Object.keys(obj ?? {}), where, errs)) return;
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY.test(k)) errs.push(`${where}: a key is not an identifier`);
    else if (!isInt(v)) errs.push(`${where}.${k} is not a non-negative integer`);
  }
}

function hashMap(obj, where, errs) {
  if (!only(obj, Object.keys(obj ?? {}), where, errs)) return;
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY.test(k)) errs.push(`${where}: a key is not an identifier`);
    else if (typeof v !== 'string' || !HEX64.test(v))
      errs.push(`${where}.${k} is not a sha256 hex digest`);
  }
}

/** Every reason the document is not a valid PHI-free result; empty array = valid. */
export function validateResult(doc) {
  const errs = [];
  if (
    !only(
      doc,
      [
        'schema',
        'run_id',
        'mode',
        'image_digest',
        'overall',
        'restore_point_age_seconds',
        'timings_seconds',
        'checks',
      ],
      'result',
      errs,
    )
  )
    return errs;
  if (doc.schema !== SCHEMA) errs.push(`schema is not ${SCHEMA}`);
  if (typeof doc.run_id !== 'string' || !RUN_ID.test(doc.run_id))
    errs.push('run_id is not a short lowercase token');
  if (!MODES.includes(doc.mode)) errs.push('mode is not latest or pitr');
  if (typeof doc.image_digest !== 'string' || !DIGEST.test(doc.image_digest))
    errs.push('image_digest is not sha256:<64 hex>');
  if (!STATUSES.includes(doc.overall)) errs.push('overall is not pass, fail or partial');
  if (!isInt(doc.restore_point_age_seconds))
    errs.push('restore_point_age_seconds is not a non-negative integer');
  if (
    only(
      doc.timings_seconds,
      ['restore', 'credentials_reset', 'checks', 'total'],
      'timings_seconds',
      errs,
    )
  )
    for (const [k, v] of Object.entries(doc.timings_seconds))
      if (!isInt(v)) errs.push(`timings_seconds.${k} is not a non-negative integer`);
  if (!Array.isArray(doc.checks)) return [...errs, 'checks is not a list'];
  const seen = new Set();
  doc.checks.forEach((c, i) => {
    const w = `checks[${i}]`;
    if (
      !only(c, ['id', 'status', 'reason', 'duration_ms', 'violations', 'counts', 'hashes'], w, errs)
    )
      return;
    if (!CHECK_IDS.includes(c.id)) errs.push(`${w}.id is not a known check`);
    if (seen.has(c.id)) errs.push(`${w}.id is repeated`);
    seen.add(c.id);
    if (!STATUSES.includes(c.status)) errs.push(`${w}.status is not pass, fail or partial`);
    if (!REASON_CODES.includes(c.reason)) errs.push(`${w}.reason is not a known reason code`);
    if (c.status === 'pass' && c.reason !== 'none') errs.push(`${w}: a pass carries reason "none"`);
    if (c.status !== 'pass' && c.reason === 'none')
      errs.push(`${w}: a ${c.status} needs a reason code`);
    if (!isInt(c.duration_ms)) errs.push(`${w}.duration_ms is not a non-negative integer`);
    if (c.violations !== undefined && !isInt(c.violations))
      errs.push(`${w}.violations is not a non-negative integer`);
    if (c.counts !== undefined) intMap(c.counts, `${w}.counts`, errs);
    if (c.hashes !== undefined) hashMap(c.hashes, `${w}.hashes`, errs);
  });
  for (const id of CHECK_IDS)
    if (!seen.has(id)) errs.push(`check "${id}" is missing: a skipped check is not a pass`);
  const worst = doc.checks.some((c) => c.status === 'fail')
    ? 'fail'
    : doc.checks.some((c) => c.status === 'partial')
      ? 'partial'
      : 'pass';
  if (doc.overall !== worst)
    errs.push(`overall "${doc.overall}" does not match the checks (${worst})`);
  return errs;
}

/** One summary line per check for the job summary and OPERATIONS-HANDOFF.md. Built from validated fields only. */
export function summarise(doc) {
  const errs = validateResult(doc);
  if (errs.length) throw new Error(`result refused: ${errs.join('; ')}`);
  const lines = [
    `restore test ${doc.run_id}: ${doc.overall} (${doc.mode}); data age at restore ${doc.restore_point_age_seconds} s; image ${doc.image_digest}`,
    `timings (s): restore ${doc.timings_seconds.restore}, credential reset ${doc.timings_seconds.credentials_reset}, checks ${doc.timings_seconds.checks}, total ${doc.timings_seconds.total}`,
  ];
  for (const c of doc.checks)
    lines.push(
      `- ${c.id}: ${c.status}${c.reason === 'none' ? '' : ` (${c.reason})`}, ${c.duration_ms} ms${c.violations ? `, ${c.violations} violation(s)` : ''}`,
    );
  return lines.join('\n');
}
