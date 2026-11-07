import type { Tx } from '@ehr/kernel';

/** An integer organisation-default setting, or `dflt` when it is missing, unreadable under the caller's policies or out of range. */
export async function intSetting(
  tx: Tx,
  key: string,
  dflt: number,
  min: number,
  max: number,
): Promise<number> {
  const r = await tx.query(
    `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`,
    [key],
  );
  const v = r.rows[0]?.['value'];
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : dflt;
}

export const ELEVATION_MINUTES = { key: 'elevation_minutes', dflt: 15, min: 1, max: 60 } as const;
export const ROLE_REQUEST_HOURS = {
  key: 'role_request_hours',
  dflt: 24,
  min: 1,
  max: 168,
} as const;
export const ENROLMENT_TOKEN_MINUTES = {
  key: 'enrolment_token_minutes',
  dflt: 30,
  min: 5,
  max: 120,
} as const;
