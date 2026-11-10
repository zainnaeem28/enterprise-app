// The bootstrap task's result (HEAAA-460 decision log 4, step 5): it writes to stdout only the mode, the run ID, the expiry and,
// per enrollee slot, the principal ID, `issued` or `skipped`, and for an issued slot the token ID and the secret ARN. The
// decision log fixes the content, not the JSON names; the names below are this ticket's reading (G-4 in README.md).
// A malformed result is a failed call: the caller deletes both secrets (decision log 4 step 4a).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// randomBytes(32) as base64url is exactly 43 characters. A run of 43 or more of these characters is treated as a possible
// token and refused, whatever the line is. Secret ARNs and UUIDs contain separators, so they do not match.
const TOKEN_LIKE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/;

export function secretArnPattern(env) {
  return new RegExp(
    `^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:bootstrap/${env}/token/[a-z0-9-]{1,40}-[A-Za-z0-9]{6}$`,
  );
}

/** @returns {{mode:string, runRef:string, expires:string, enrollees:Array<object>}} or throws a message that holds no log content. */
export function parseTaskResult(lines, { env, runRef, now = new Date() }) {
  const arnRe = secretArnPattern(env);
  let found = null;
  for (const line of lines) {
    if (TOKEN_LIKE.test(line))
      throw new Error(
        'task output contains a token-like string: treated as a leak; the secrets are deleted and the run is an incident',
      );
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j && typeof j === 'object' && Array.isArray(j.enrollees)) {
      if (found) throw new Error('task wrote more than one result line');
      found = j;
    }
  }
  if (!found) throw new Error('task wrote no result line');
  const j = found;
  if (j.mode !== 'create' && j.mode !== 'reissue')
    throw new Error(`result mode "${j.mode}" is not create or reissue`);
  if (j.run_ref !== runRef) throw new Error('result run_ref is not this run');
  const ex = Date.parse(j.expires);
  if (Number.isNaN(ex)) throw new Error('result expires is missing or malformed');
  if (ex - now.getTime() > 31 * 60 * 1000)
    throw new Error('result expiry is more than 30 minutes away');
  if (j.enrollees.length !== 2) throw new Error('result must name two enrollee slots');
  const slots = new Set();
  const enrollees = j.enrollees.map((x) => {
    if (!x || typeof x !== 'object') throw new Error('result enrollee is not an object');
    if (!/^[a-z0-9-]{1,40}$/.test(x.slot ?? '')) throw new Error('result slot is malformed');
    if (slots.has(x.slot)) throw new Error('result repeats a slot');
    slots.add(x.slot);
    if (!UUID.test(x.principal_id ?? '')) throw new Error('result principal_id is not a UUID');
    if (x.result === 'issued') {
      if (!UUID.test(x.token_id ?? '')) throw new Error('issued slot has no token_id');
      if (!arnRe.test(x.secret_arn ?? '') || !x.secret_arn.includes(`/token/${x.slot}-`))
        throw new Error('issued slot secret_arn is not bootstrap/<env>/token/<slot>');
    } else if (x.result === 'skipped') {
      if (x.secret !== 'deleted') throw new Error('skipped slot must report its secret as deleted');
    } else throw new Error(`slot result "${x.result}" is neither issued nor skipped`);
    return {
      slot: x.slot,
      principalId: x.principal_id,
      result: x.result,
      tokenId: x.token_id,
      secretArn: x.secret_arn,
    };
  });
  return { mode: j.mode, runRef: j.run_ref, expires: new Date(ex).toISOString(), enrollees };
}

export const secretName = (arn) =>
  arn.replace(/^[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:secret:/, '').replace(/-[A-Za-z0-9]{6}$/, '');
