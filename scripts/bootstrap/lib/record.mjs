// The `bootstrap-<env>` and `audit-archive` approved records (DEVOPS-PLAN 7.4, 16.2, 4.1 A2). The trust policy of the role carries
// the expiry in AWS; this is the workflow's own check (15.3) and refuses on any mismatch. Pure functions: nothing here talks to AWS.
//
// Fields the DEVOPS-PLAN 7.4 record shape and the ci-trust module already carry: state, environment, permitted_actions,
// g3_reference, not_before, expires, approvals, applier.
// Fields HEAAA-460 decision log 4 / 4.1 add for bootstrap: custodians[], enrollees[], ticket_ref, security_contact_verified_at,
// security_contact_test_ref. The decision log fixes what they hold, not their JSON names; the names below are this ticket's
// reading and are listed as an open interface point in scripts/bootstrap/README.md (G-4). The bootstrap task re-reads and
// re-checks the same record itself; this check only stops a doomed or mistaken run before a task is started.
const DAY = 24 * 3600 * 1000;
export const SECURITY_CONTACT_MAX_AGE_MS = 72 * 3600 * 1000;

function parse(text, what) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return { errs: [`${what} record is not valid JSON`] };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r))
    return { errs: [`${what} record is not an object`] };
  return { r, errs: [] };
}

function common(r, { environment, action, now, what }) {
  const e = [];
  if (r.state !== 'approved')
    e.push(`record state is "${r.state}", not "approved" (missing or empty record)`);
  if (r.environment !== environment)
    e.push(`record is for environment "${r.environment}", this run is for "${environment}"`);
  const permitted = Array.isArray(r.permitted_actions) ? r.permitted_actions : [];
  if (!permitted.includes(action)) e.push(`action "${action}" is not in permitted_actions`);
  if (!r.g3_reference || typeof r.g3_reference !== 'string') e.push('record has no g3_reference');
  // Two distinct human approvals (4.1 A2); the applier may be one of them but never the only one.
  const approvals = Array.isArray(r.approvals) ? r.approvals : [];
  if (new Set(approvals).size < 2)
    e.push(
      `${what} needs two distinct human approvals (4.1 A2); the record names ${new Set(approvals).size}`,
    );
  if (typeof r.applier !== 'string' || !r.applier) e.push('record names no applier');
  const nb = Date.parse(r.not_before);
  const ex = Date.parse(r.expires);
  if (Number.isNaN(nb) || Number.isNaN(ex))
    e.push('record not_before/expires missing or malformed');
  else {
    if (now.getTime() < nb) e.push(`record is not valid before ${r.not_before}`);
    if (now.getTime() >= ex) e.push(`record expired at ${r.expires}`);
    if (ex - nb > DAY) e.push('record window exceeds one day (7.4)');
  }
  return e;
}

/** Every reason the bootstrap record does not authorise this run; empty array = it does. */
export function checkBootstrapRecord(text, { environment, now = new Date() }) {
  const p = parse(text, 'bootstrap');
  if (p.errs.length) return p.errs;
  const r = p.r;
  const e = common(r, {
    environment,
    action: 'bootstrap',
    now,
    what: 'the bootstrap enabling change',
  });
  if (!r.ticket_ref || typeof r.ticket_ref !== 'string') e.push('record has no ticket_ref');

  const cust = Array.isArray(r.custodians) ? r.custodians : [];
  const enr = Array.isArray(r.enrollees) ? r.enrollees : [];
  if (cust.length !== 2) e.push(`two named custodians are required (found ${cust.length})`);
  if (enr.length !== 2) e.push(`two enrollees are required (found ${enr.length})`);
  const ids = cust.map((c) => c?.identity_center_user_id);
  const roles = cust.map((c) => c?.role_arn);
  if (ids.some((v) => !v) || new Set(ids).size !== ids.length)
    e.push('custodians need distinct IAM Identity Center user IDs');
  if (roles.some((v) => !v) || new Set(roles).size !== roles.length)
    e.push('custodians need distinct IAM Identity Center role ARNs');
  const handles = enr.map((x) => x?.handle);
  const arns = enr.map((x) => x?.identity_arn);
  if (handles.some((v) => !v) || new Set(handles).size !== handles.length)
    e.push('enrollees need distinct handles');
  if (arns.some((v) => !v) || new Set(arns).size !== arns.length)
    e.push('enrollees need distinct identity ARNs (for the explicit deny)');
  // DPR-23: a custodian never retrieves their own token. Custodian i reads enrollee i's slot: they must not be the same person.
  for (let i = 0; i < Math.min(cust.length, enr.length); i++) {
    if (
      cust[i]?.identity_center_user_id &&
      cust[i].identity_center_user_id === enr[i]?.identity_center_user_id
    )
      e.push(
        `custodian ${i + 1} is enrollee ${i + 1}: a custodian never retrieves their own token (DPR-23)`,
      );
    if (cust[i]?.role_arn && enr[i]?.identity_arn && cust[i].role_arn === enr[i].identity_arn)
      e.push(`custodian ${i + 1} role is enrollee ${i + 1}'s identity (DPR-23)`);
  }

  // 1a: the security contact was tested with a real notice no more than 72 h ago (runbook step 0).
  const v = Date.parse(r.security_contact_verified_at);
  if (Number.isNaN(v))
    e.push('security_contact_verified_at is missing or malformed (runbook step 0)');
  else {
    if (v > now.getTime() + 5 * 60 * 1000) e.push('security_contact_verified_at is in the future');
    if (now.getTime() - v > SECURITY_CONTACT_MAX_AGE_MS)
      e.push('security_contact_verified_at is older than 72 hours: repeat runbook step 0');
  }
  if (!r.security_contact_test_ref || typeof r.security_contact_test_ref !== 'string')
    e.push('security_contact_test_ref is missing (runbook step 0)');
  return e;
}

export const PARTITION = /^audit\.event_[0-9]{4}_(0[1-9]|1[0-2])$/;

/** Every reason the audit-archive record does not authorise archiving `partition`; empty array = it does. */
export function checkArchiveRecord(text, { partition, now = new Date() }) {
  const p = parse(text, 'audit-archive');
  if (p.errs.length) return p.errs;
  const e = common(p.r, {
    environment: 'production',
    action: 'audit-archive',
    now,
    what: 'archival',
  });
  // The task takes no arguments, so the partition comes from this record, never from a workflow input: the record names
  // exactly one `archive:<partition>` and the dispatch input must agree with it (a typo cannot drop another month).
  const named = (Array.isArray(p.r.permitted_actions) ? p.r.permitted_actions : []).filter(
    (a) => typeof a === 'string' && a.startsWith('archive:'),
  );
  if (named.length !== 1)
    e.push(`the record must name exactly one "archive:<partition>" action (found ${named.length})`);
  else if (!PARTITION.test(named[0].slice('archive:'.length)))
    e.push(`"${named[0]}" is not archive:audit.event_YYYY_MM`);
  else if (named[0] !== `archive:${partition}`)
    e.push(`dispatch partition "${partition}" is not the record's "${named[0]}"`);
  if (!PARTITION.test(partition ?? ''))
    e.push(`partition "${partition}" is not audit.event_YYYY_MM`);
  return e;
}
