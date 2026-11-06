// `notifications.staff_alert_setting` (ARCHITECTURE 22.13, 29.4 `/admin/alert-settings`): when an unacknowledged alert escalates
// and to which duty role. There is no default for `red_flag` (D-12a): without a row the alert has no timer.
// The admin routes (realm admin_pool, elevation) are thin wrappers over these two functions and belong to the integration step.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../../audit/index.js';
import { NotificationsValidationError } from '../errors.js';
import { isUuid, uuidv7 } from '../ids.js';
import { ALERT_TYPES } from './types.js';

export interface AlertSetting {
  alertType: string;
  locationId: string | null;
  escalateAfterMin: number;
  escalateToDuty: string;
}

export class AlertSettingService {
  constructor(private readonly d: { audit?: AuditService } = {}) {}

  async list(tx: Tx): Promise<AlertSetting[]> {
    const r = await tx.query(
      `SELECT alert_type, location_id, escalate_after_min, escalate_to_duty
         FROM notifications.staff_alert_setting ORDER BY alert_type, location_id NULLS FIRST`,
    );
    return r.rows.map((x) => ({
      alertType: String(x['alert_type']),
      locationId: (x['location_id'] as string | null) ?? null,
      escalateAfterMin: Number(x['escalate_after_min']),
      escalateToDuty: String(x['escalate_to_duty']),
    }));
  }

  /** Inserts or updates the row for (type, location). Admin realm only (the policy). */
  async put(tx: Tx, s: AlertSetting, requestId?: string): Promise<void> {
    const bad: string[] = [];
    if (!(ALERT_TYPES as readonly string[]).includes(s.alertType)) bad.push('alertType');
    if (s.locationId !== null && !isUuid(s.locationId)) bad.push('locationId');
    if (
      !Number.isInteger(s.escalateAfterMin) ||
      s.escalateAfterMin < 1 ||
      s.escalateAfterMin > 10080
    )
      bad.push('escalateAfterMin');
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(s.escalateToDuty)) bad.push('escalateToDuty');
    if (bad.length > 0) throw new NotificationsValidationError(bad);
    const id = uuidv7();
    const r = await tx.query(
      `INSERT INTO notifications.staff_alert_setting
         (id, organisation_id, alert_type, location_id, escalate_after_min, escalate_to_duty, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ON CONSTRAINT staff_alert_setting_uq
       DO UPDATE SET escalate_after_min = EXCLUDED.escalate_after_min, escalate_to_duty = EXCLUDED.escalate_to_duty
       RETURNING id`,
      [
        id,
        tx.scope.orgId,
        s.alertType,
        s.locationId,
        s.escalateAfterMin,
        s.escalateToDuty,
        tx.scope.principalId ?? null,
      ],
    );
    if (this.d.audit !== undefined && requestId !== undefined) {
      await this.d.audit.record(tx, {
        action: 'config_change',
        requestId,
        resourceType: 'notifications.staff_alert_setting',
        resourceId: String((r.rows[0] as Record<string, unknown>)['id']),
        change: { alertType: s.alertType, escalateAfterMin: s.escalateAfterMin },
      });
    }
  }
}
