// The archive task's result. ARCHITECTURE 6: a partition is detached and dropped only (a) after the archive copy is verified by
// reading it back and checking row count and anchor roots, (b) under dual control, (c) with an audit event and a manifest entry
// for the drop itself. The task does (a) and (c) inside the database and the archive bucket; this check refuses a result that
// does not claim every one of them for the partition that was asked for. It contains counts, hashes and IDs only, no row data.
// The JSON names are this ticket's reading of the contract (G-4 in ../README.md).
const HEX64 = /^[0-9a-f]{64}$/;
const UUIDLIKE = /^[0-9a-zA-Z-]{8,64}$/;
import { PARTITION } from '../lib/record.mjs';

export function parseArchiveResult(lines, { partition }) {
  let found = null;
  for (const line of lines) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j && typeof j === 'object' && 'readback' in j) {
      if (found) throw new Error('task wrote more than one result line');
      found = j;
    }
  }
  if (!found) throw new Error('task wrote no result line');
  const j = found;
  if (!PARTITION.test(j.partition ?? '') || j.partition !== partition)
    throw new Error('result is for a different partition');
  const rb = j.readback ?? {};
  if (rb.verified !== true) throw new Error('archive copy was not verified by read-back');
  if (!Number.isInteger(rb.row_count) || rb.row_count < 0)
    throw new Error('read-back row_count is not a count');
  if (rb.row_count !== j.hot_row_count)
    throw new Error('archive row count differs from the hot partition row count');
  if (
    !HEX64.test(rb.anchor_roots_sha256 ?? '') ||
    rb.anchor_roots_sha256 !== j.hot_anchor_roots_sha256
  )
    throw new Error('anchor roots of the archive copy differ from the database');
  if (rb.object_lock !== 'COMPLIANCE')
    throw new Error('archive object is not under Object Lock compliance mode');
  if (typeof j.archive_key !== 'string' || !j.archive_key)
    throw new Error('result has no archive_key');
  if (j.dropped !== true) throw new Error('partition was not dropped');
  if (!UUIDLIKE.test(String(j.audit_event_id ?? '')))
    throw new Error('the drop has no audit event');
  if (!j.manifest_entry || typeof j.manifest_entry !== 'string')
    throw new Error('the drop has no manifest entry');
  return {
    partition: j.partition,
    rowCount: rb.row_count,
    anchorRootsSha256: rb.anchor_roots_sha256,
    archiveKey: j.archive_key,
    auditEventId: String(j.audit_event_id),
    manifestEntry: j.manifest_entry,
  };
}
