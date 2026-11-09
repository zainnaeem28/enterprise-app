// The `restore-test` approved record (DEVOPS-PLAN 7.4): standing operations authority from OPERATIONS_RECEIPT, one
// year at most. The role's trust policy already carries the expiry; this is the workflow's own check (15.3) and
// refuses on any mismatch. A `release` record does not enable this role, and the reverse.
export function checkRestoreRecord(text, { now = new Date(), action = 'restore-test' } = {}) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return ['restore-test record is not valid JSON'];
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['restore-test record is not an object'];
  const e = [];
  if (r.state !== 'approved') e.push(`record state is "${r.state}", not "approved"`);
  if (r.environment !== 'production') e.push(`record is for environment "${r.environment}", not "production"`);
  const permitted = Array.isArray(r.permitted_actions) ? r.permitted_actions : [];
  if (!permitted.includes(action)) e.push(`action "${action}" is not in permitted_actions`);
  if (!Array.isArray(r.approvals) || r.approvals.length < 1) e.push('record names no approver');
  const nb = Date.parse(r.not_before);
  const ex = Date.parse(r.expires);
  if (Number.isNaN(nb) || Number.isNaN(ex)) e.push('record not_before/expires missing or malformed');
  else {
    if (now.getTime() < nb) e.push(`record is not valid before ${r.not_before}`);
    if (now.getTime() >= ex) e.push(`record expired at ${r.expires}`);
    if (ex - nb > 366 * 24 * 3600 * 1000) e.push('record window exceeds one year');
  }
  return e;
}
