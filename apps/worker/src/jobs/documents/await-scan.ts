// `documents.await_scan` (ARCHITECTURE 25.10, 22.16 "jobs in flight", PRD BR-28, AC-30). Started by the upload's completion with the
// document, the version and the patient (`on_merged = resolve`).
//
// Each run is a few short transactions and never holds one open across a store or scanner call:
//   1. claim:    read the document and version under the job's scope. A document no longer `scanning` ends the job without writing
//                (a finished document is kept). A merged patient finds no row under its scope: ask for the survivor and run again under
//                the survivor's scope; the rows were re-pointed, so the job finishes on the survivor (38.2 item 11).
//   2. look:     the quarantine object and the scan verdict. No object, or no verdict yet: poll again (10 s for the first minute, then
//                60 s), for 30 minutes from the upload's completion; then the version shows `error`, operations are alerted, and the
//                job keeps trying every 5 minutes (up to 24 hours). A scanner that cannot be asked is `error` too, never `clean`: the
//                file stays unavailable (TC-DOC-08) and the document stays `scanning`.
//   3. infected: the version is `infected`, the document `quarantined`; the file stays in quarantine and is never served; the uploader
//                is told through the event and operations through the alert (AC-30, X-17). A file whose bytes are not the declared type,
//                whose size is not the declared one, or whose structure is broken is refused the same way.
//   4. clean:    read the object, sniff the type, remove image metadata, hash, write a COPY under a new random key in the clean bucket,
//                and only then (one transaction) mark the version `clean` with the new key and the document `clean`, queue the OCR
//                suggestion and publish `documents.scan_completed`. The quarantine object is removed after the commit.
import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '@ehr/kernel';
import { isUuid } from './ids.js';
import { DEFAULT_SCHEDULE, InvalidFile } from './ports.js';
import type { DocumentsJobDeps, OpsAlert, ScanState } from './ports.js';
import { patientsScope } from './scope.js';
import { sniffType } from './sniff.js';

type Row = Record<string, unknown>;

export type ScanOutcome = 'clean' | 'quarantined' | 'polling' | 'error' | 'already_final' | 'gone';

const jobKey = (documentId: string, version: number): string =>
  `await_scan_${documentId}_${version}`;

interface Ctx {
  patientId: string;
}

/** Runs `fn` under the patient's scope; a row hidden by a merge sends it to the survivor's scope once. */
async function writeFor<T>(
  deps: DocumentsJobDeps,
  ctx: Ctx,
  fn: (tx: Tx, patientId: string) => Promise<T | 'gone'>,
): Promise<T | 'gone'> {
  const attempt = (pid: string): Promise<T | 'gone'> =>
    deps.db.withScope(patientsScope(deps.orgId, [pid]), (tx) => fn(tx, pid));
  let r = await attempt(ctx.patientId);
  if (r === 'gone' && deps.survivorOf !== undefined) {
    const survivor = (await deps.survivorOf(ctx.patientId))?.toLowerCase();
    if (survivor !== undefined && survivor !== ctx.patientId.toLowerCase()) {
      ctx.patientId = survivor;
      r = await attempt(survivor);
    }
  }
  return r;
}

const VERSION_SQL = `
  SELECT d.status, d.current_version, d.patient_id, v.object_key, v.size_bytes, v.declared_content_type, v.scan_status, v.scan_requested_at
    FROM documents.document d JOIN documents.document_version v ON v.document_id = d.id AND v.version = $2
   WHERE d.id = $1::uuid`;

async function audit(
  tx: Tx,
  jobId: string,
  documentId: string,
  patientId: string,
  change: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
     VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'update', 'documents.document', $2::uuid, $3::uuid, $4::jsonb, 'allowed')`,
    [jobId.slice(0, 200), documentId, patientId, JSON.stringify(change)],
  );
}

export async function runAwaitScan(
  deps: DocumentsJobDeps,
  payload: Record<string, unknown>,
  jobRef = 'documents.await_scan',
): Promise<ScanOutcome> {
  const documentId = payload['documentId'];
  const version = payload['version'];
  const patientId = payload['patientId'];
  if (!isUuid(documentId) || !Number.isInteger(version) || !isUuid(patientId))
    throw new Error('documents.await_scan: bad payload');
  const v = version as number;
  const now = deps.now ?? ((): Date => new Date());
  const sched = deps.schedule ?? DEFAULT_SCHEDULE;
  const ctx: Ctx = { patientId: patientId.toLowerCase() };
  const jobId = `${jobRef}:${documentId}:${v}`;
  const alert = (kind: OpsAlert['kind']): void =>
    deps.alert?.({ kind, documentId, version: v, patientId: ctx.patientId });

  // 1. claim
  const claimed = await writeFor<Row | 'final'>(deps, ctx, async (tx) => {
    const r = (await tx.query(VERSION_SQL, [documentId, v])).rows[0] as Row | undefined;
    if (r === undefined) return 'gone';
    return r['status'] === 'scanning' ? r : 'final';
  });
  if (claimed === 'gone') return 'gone';
  if (claimed === 'final') return 'already_final';
  const row = claimed;
  const key = String(row['object_key']);
  const requestedAt =
    row['scan_requested_at'] instanceof Date ? (row['scan_requested_at'] as Date) : now();
  const age = now().getTime() - requestedAt.getTime();

  const reschedule = (ms: number): Promise<'gone' | true> =>
    writeFor<true>(deps, ctx, async (tx, pid) => {
      await deps.queue.enqueue(
        tx,
        'documents.await_scan',
        { documentId, version: v, patientId: pid },
        { runAt: new Date(now().getTime() + ms), jobKey: jobKey(documentId, v) },
      );
      return true;
    });
  const setScanStatus = (status: 'pending' | 'error'): Promise<'gone' | boolean> =>
    writeFor<boolean>(deps, ctx, async (tx) => {
      const u = await tx.query(
        `UPDATE documents.document_version SET scan_status = $3 WHERE document_id = $1::uuid AND version = $2 AND scan_status <> $3 AND scan_status IN ('pending', 'error')`,
        [documentId, v, status],
      );
      return (u.rowCount ?? 0) > 0;
    });

  // 2. look
  const obj = await deps.store.head('quarantine', key);
  let state: ScanState;
  if (obj === null) state = 'pending';
  else {
    try {
      state = await deps.scan('quarantine', key);
    } catch {
      state = 'error';
    }
  }

  if (state === 'pending' || state === 'error') {
    if (age > sched.giveUpMs) return 'error';
    if (state === 'error') {
      if ((await setScanStatus('error')) === true) alert('scan_error');
      await reschedule(sched.slowMs);
      return 'error';
    }
    if (age < sched.timeoutMs) {
      if (String(row['scan_status']) === 'error') await setScanStatus('pending');
      await reschedule(age < sched.fastWindowMs ? sched.fastMs : sched.slowMs);
      return 'polling';
    }
    if ((await setScanStatus('error')) === true) alert('scan_timeout');
    await reschedule(sched.afterTimeoutMs);
    return 'error';
  }

  const quarantine = async (kind: 'quarantined' | 'rejected_file'): Promise<ScanOutcome> => {
    const done = await writeFor<true>(deps, ctx, async (tx, pid) => {
      const u = await tx.query(
        `UPDATE documents.document_version SET scan_status = 'infected', scanned_at = $3::timestamptz
          WHERE document_id = $1::uuid AND version = $2 AND scan_status IN ('pending', 'error')`,
        [documentId, v, now().toISOString()],
      );
      if ((u.rowCount ?? 0) === 0) return 'gone';
      const d = await tx.query(
        `UPDATE documents.document SET status = 'quarantined' WHERE id = $1::uuid AND status = 'scanning'`,
        [documentId],
      );
      if ((d.rowCount ?? 0) === 0) return 'gone';
      await audit(tx, jobId, documentId, pid, { status: 'quarantined' });
      await deps.queue.publish(tx, 'documents.quarantined', { documentId, patientId: pid });
      return true;
    });
    if (done === 'gone') return 'gone';
    alert(kind);
    return 'quarantined';
  };

  if (state === 'infected') return quarantine('quarantined');

  // 4. clean: the content is checked here regardless of what the scanner said about it.
  if (obj === null || obj.sizeBytes !== Number(row['size_bytes']))
    return quarantine('rejected_file');
  let content: Buffer;
  let sniffed: string;
  let finalBytes: Buffer;
  try {
    content = await deps.store.read('quarantine', key, Number(row['size_bytes']));
    const t = sniffType(content);
    if (t === null || t !== row['declared_content_type']) return quarantine('rejected_file');
    sniffed = t;
    finalBytes = deps.reencode.reencode(t, content);
  } catch (e) {
    if (e instanceof InvalidFile) return quarantine('rejected_file');
    throw e;
  }
  const sha = createHash('sha256').update(finalBytes).digest();
  const newKey = `c/${randomBytes(16).toString('hex')}`;
  await deps.store.put('clean', newKey, finalBytes, sniffed);

  const promoted = await writeFor<true>(deps, ctx, async (tx, pid) => {
    const u = await tx.query(
      `UPDATE documents.document_version
          SET scan_status = 'clean', scanned_at = $3::timestamptz, sha256 = $4, size_bytes = $5::bigint, content_type = $6,
              bucket = 'clean', object_key = $7, ocr_status = 'pending'
        WHERE document_id = $1::uuid AND version = $2 AND scan_status IN ('pending', 'error')`,
      [documentId, v, now().toISOString(), sha, finalBytes.length, sniffed, newKey],
    );
    if ((u.rowCount ?? 0) === 0) return 'gone';
    const d = await tx.query(
      `UPDATE documents.document SET status = 'clean' WHERE id = $1::uuid AND status = 'scanning'`,
      [documentId],
    );
    if ((d.rowCount ?? 0) === 0) return 'gone';
    await deps.queue.enqueue(
      tx,
      'documents.ocr_suggest',
      { documentId, version: v, patientId: pid },
      { jobKey: `ocr_${documentId}_${v}` },
    );
    await deps.queue.publish(tx, 'documents.scan_completed', { documentId, patientId: pid });
    await audit(tx, jobId, documentId, pid, { status: 'clean' });
    return true;
  });
  if (promoted === 'gone') {
    await deps.store.remove('clean', newKey); // our copy belongs to no row
    return 'gone';
  }
  try {
    await deps.store.remove('quarantine', key);
  } catch {
    // The quarantine bucket's lifecycle rule (IaC) also expires it; the row no longer names this key.
    deps.log.warn('quarantine object not removed', { documentId });
  }
  return 'clean';
}
