// Who may read the chart (ARCHITECTURE 27.1, 27.4, 28.2; BQ-5 default; AC-12). The route guard already enforces the assignment
// rule for routes declared `clinical.chart.read`. This class applies the same rule where a handler serves more than one kind of
// caller (the chart summary and the banner serve `clinical.chart.read` AND `clinical.chart.read_previsit` holders) and for the
// writes, which are declared `clinical.list.write`. It never widens what the guard allows.
//
//   chart  : the caller holds `clinical.chart.read` AND (a break-the-glass grant for the patient OR `isAssigned`)
//   previsit: the caller holds `clinical.chart.read_previsit` at a location where the patient is in scope
//
// A caller who holds `clinical.chart.read` but is neither assigned nor under BTG is refused `403 clinical.not_assigned`
// (+ `btgAvailable`), and the refusal is audited as `denied` in its own transaction; opening BTG (`audit.openBtg`) then raises the
// compliance alert and the next request passes. Being a pre-visit holder as well does not turn that refusal into a partial answer.
import type { KernelDb, Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import { NotAssignedError } from '../../identity/index.js';
import type { AssignmentResolver, AuthContext } from '../../identity/index.js';
import { ChartNotFoundError } from './errors.js';
import { isUuid } from './ids.js';
import type { RequestMeta } from './types.js';

export type ChartAccessLevel = 'chart' | 'previsit' | 'none';

export interface AccessDeps {
  db: KernelDb;
  audit: AuditService;
  assignment: Pick<AssignmentResolver, 'isAssigned'>;
}

export class ChartAccess {
  constructor(private readonly deps: AccessDeps) {}

  private static btg(ctx: AuthContext, patientId: string): boolean {
    return (
      ctx.scope.btgPatientIds?.some((p) => p.toLowerCase() === patientId.toLowerCase()) === true
    );
  }

  /** Holds `clinical.chart.read` and passes the assignment rule (or BTG). Does not throw. */
  async chartRead(tx: Tx, ctx: AuthContext, patientId: string): Promise<boolean> {
    if (!ctx.grants.has('clinical.chart.read')) return false;
    if (ChartAccess.btg(ctx, patientId)) return true;
    return this.deps.assignment.isAssigned(tx, ctx.session.principalId, patientId);
  }

  /** Holds `clinical.chart.read_previsit` at a location where the patient is in scope (27.1). Does not throw. */
  async previsitRead(tx: Tx, ctx: AuthContext, patientId: string): Promise<boolean> {
    if (!ctx.grants.has('clinical.chart.read_previsit')) return false;
    // staff_scope shows a staff transaction only the rows at its own locations (T-STAFF), so these are the locations that count.
    const r = await tx.query(
      `SELECT location_id FROM patient.staff_scope WHERE patient_id = $1::uuid`,
      [patientId],
    );
    return (r.rows as Record<string, unknown>[]).some((x) =>
      ctx.grants.has('clinical.chart.read_previsit', String(x['location_id'])),
    );
  }

  /**
   * The strongest level the caller reaches. A `clinical.chart.read` holder who fails the assignment rule is refused (not downgraded
   * to pre-visit): see the header.
   */
  async level(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<ChartAccessLevel> {
    if (!isUuid(patientId)) throw new ChartNotFoundError();
    if (ctx.grants.has('clinical.chart.read')) {
      if (await this.chartRead(tx, ctx, patientId)) return 'chart';
      await this.refuse(ctx, meta, patientId);
    }
    return (await this.previsitRead(tx, ctx, patientId)) ? 'previsit' : 'none';
  }

  /** Chart-level access or `403 clinical.not_assigned`; for the writes (`clinical.list.write`) and the chart summary. */
  async requireChart(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<void> {
    if (!isUuid(patientId)) throw new ChartNotFoundError();
    if (await this.chartRead(tx, ctx, patientId)) return;
    await this.refuse(ctx, meta, patientId);
  }

  /** The audited refusal: a `denied` event in its own transaction (the business transaction rolls back), then the 403. */
  private async refuse(ctx: AuthContext, meta: RequestMeta, patientId: string): Promise<never> {
    await this.deps.audit.recordDenied(this.deps.db, ctx.scope, {
      requestId: meta.requestId,
      resourceType: 'clinical.chart',
      patientId,
      denialReason: 'forbidden',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    throw new NotAssignedError();
  }
}
