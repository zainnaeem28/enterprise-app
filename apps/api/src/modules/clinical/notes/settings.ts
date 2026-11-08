// The two G2 settings of the notes (ARCHITECTURE 22.5 settings catalogue: `note_sign_deadline_hours` 24, `note_sign_max_auth_age` 12 h,
// BQ-8). Read in the caller's own transaction from `kernel.setting` (organisation-wide row); an absent or malformed value falls back to the
// catalogue default, never to "no limit".
import type { Tx } from '@ehr/kernel';

export const NOTE_SIGN_DEADLINE_HOURS = { key: 'note_sign_deadline_hours', fallback: 24 } as const;
export const NOTE_SIGN_MAX_AUTH_AGE = { key: 'note_sign_max_auth_age', fallback: 12 } as const;

export async function hoursSetting(tx: Tx, s: { key: string; fallback: number }): Promise<number> {
  const r = await tx.query(
    `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`,
    [s.key],
  );
  const v = r.rows[0]?.['value'];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 24 * 365 ? v : s.fallback;
}
