// The audit port of the chart services. Every chart audit row written while the caller holds an active break-the-glass grant for the
// patient names that grant (`btg_grant_id`), so the compliance reviewer of a BTG event (AC-12, TC-AZ-10/11) sees exactly what the
// holder read and wrote under it. The grant is looked up once per transaction and patient; a caller with no grant for the patient
// (the common case) costs nothing: the scope's `btgPatientIds` is checked first.
import type { Tx } from '@ehr/kernel';
import type { AuditEnvelope, AuditService } from '../../audit/index.js';

export interface ChartAuditPort {
  record(tx: Tx, envelope: AuditEnvelope): Promise<string>;
}

export class BtgAwareAudit implements ChartAuditPort {
  private readonly grants = new WeakMap<Tx, Map<string, string | null>>();

  constructor(private readonly audit: Pick<AuditService, 'record' | 'activeBtgGrants'>) {}

  private async grantFor(tx: Tx, patientId: string): Promise<string | null> {
    const p = patientId.toLowerCase();
    if (
      tx.scope.principalId === undefined ||
      tx.scope.btgPatientIds?.some((x) => x.toLowerCase() === p) !== true
    )
      return null;
    let byPatient = this.grants.get(tx);
    if (byPatient === undefined) {
      byPatient = new Map();
      this.grants.set(tx, byPatient);
    }
    if (!byPatient.has(p)) {
      const g = (await this.audit.activeBtgGrants(tx, tx.scope.principalId)).find(
        (x) => x.patientId.toLowerCase() === p,
      );
      byPatient.set(p, g?.grantId ?? null);
    }
    return byPatient.get(p) ?? null;
  }

  async record(tx: Tx, envelope: AuditEnvelope): Promise<string> {
    if (
      envelope.btgGrantId === undefined &&
      envelope.patientId !== undefined &&
      envelope.patientId !== null
    ) {
      const g = await this.grantFor(tx, envelope.patientId);
      if (g !== null) return this.audit.record(tx, { ...envelope, btgGrantId: g });
    }
    return this.audit.record(tx, envelope);
  }
}
