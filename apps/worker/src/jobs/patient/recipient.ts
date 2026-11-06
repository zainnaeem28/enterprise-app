// The recipient-resolution contributor `patient` registers with `notifications` (SHARED-BOUNDARIES 3.2 rule 7, ARCHITECTURE 24):
// the contact points on the patient record and the communication preference, applied by the notifications rule. Runs in the sending
// job's scope (audience `system`, narrowed to the patient) and answers for ONE patient. A merged patient answers `undefined`; the
// sending job then asks `survivorOf` and runs again for the survivor (`on_merged = resolve`). Nothing returned is stored.
import type { KernelDb, Tx } from '@ehr/kernel';
import { applyCommunicationPreferences } from '../notifications/index.js';
import type {
  CommunicationPreference,
  DeliveryChannel,
  RecipientContributor,
  ResolvedRecipient,
} from '../notifications/index.js';
import { isUuid } from './ids.js';
import { systemScope } from './scope.js';

type Row = Record<string, unknown>;

export const patientRecipientContributor: RecipientContributor = {
  async resolve(tx: Tx, id: string): Promise<ResolvedRecipient | undefined> {
    if (!isUuid(id)) return undefined;
    const p = await tx.query(
      `SELECT p.status, p.phone_e164, p.email, p.preferred_language,
              c.channels, c.reminder_channel, c.language, c.quiet_hours
         FROM patient.patient p LEFT JOIN patient.communication_preference c ON c.patient_id = p.id
        WHERE p.id = $1::uuid`,
      [id],
    );
    const row = p.rows[0] as Row | undefined;
    if (row === undefined || row['status'] !== 'active') return undefined;
    const language = String(row['language'] ?? row['preferred_language'] ?? 'en');
    const stored = row['channels'] as DeliveryChannel[] | null;
    const pref: CommunicationPreference = {
      // No stored preference yet: reachable by e-mail (if there is an address) and in the app; SMS is opt-in.
      channels: stored ?? (row['email'] ? ['email', 'in_app'] : ['in_app']),
      language,
      ...(row['reminder_channel']
        ? { reminderChannel: row['reminder_channel'] as DeliveryChannel }
        : {}),
      ...(row['quiet_hours']
        ? { quietHours: row['quiet_hours'] as NonNullable<CommunicationPreference['quietHours']> }
        : {}),
    };
    const { permitted, withheld } = applyCommunicationPreferences(
      {
        ...(row['email'] ? { email: String(row['email']) } : {}),
        ...(row['phone_e164'] ? { phone: String(row['phone_e164']) } : {}),
      },
      pref,
    );
    return {
      active: true,
      language,
      permitted,
      withheld,
      ...(pref.quietHours === undefined ? {} : { quietHours: pref.quietHours }),
    };
  },
};

/**
 * `survivorOf(patientId)` for the sending job (`SendDeps.survivorOf`): the final survivor of a merged ID, from the merge map; the ID
 * itself when it is active; undefined when unknown. Its own short transaction under an organisation-wide system scope.
 */
export function createSurvivorOf(
  db: KernelDb,
  orgId: string,
): (patientId: string) => Promise<string | undefined> {
  return async (patientId) => {
    if (!isUuid(patientId)) return undefined;
    return db.withScope(systemScope(orgId), async (tx) => {
      const r = await tx.query(
        `SELECT coalesce(m.final_survivor_id, p.id) AS id
           FROM patient.patient p LEFT JOIN patient.patient_merge m ON m.merged_id = p.id WHERE p.id = $1::uuid`,
        [patientId],
      );
      const row = r.rows[0] as Row | undefined;
      return row === undefined ? undefined : String(row['id']);
    });
  };
}
