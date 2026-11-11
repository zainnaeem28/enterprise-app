// Test fixtures only (ruling C item 4, D-2 / C-06): no state list exists in production code, seeds or migrations. The organisation
// records its real operating states and each clinician's licensed states through the admin API at go-live. The tests need *some*
// jurisdiction rows, so they take them from this one configured fixture: three synthetic two-letter codes that are not USPS states,
// overridable with EHR_FIXTURE_STATES="AA,BB,CC" (licensed + operating, operating but not licensed, not operating). Nothing outside
// *.test.ts, *.dbtest.ts and testkit.ts files imports this file.
const configured = (process.env['EHR_FIXTURE_STATES'] ?? 'ZA,ZB,ZC')
  .split(',')
  .map((s) => s.trim().toUpperCase());
if (
  configured.length !== 3 ||
  !configured.every((s) => /^[A-Z]{2}$/.test(s)) ||
  new Set(configured).size !== 3
)
  throw new Error('EHR_FIXTURE_STATES must be three distinct two-letter codes');

export const FIXTURE_STATES = {
  /** An operating state (telehealth allowed) in which the fixture clinician holds a recorded licence. */
  licensed: configured[0]!,
  /** An operating state (telehealth allowed) in which the fixture clinician holds no licence. */
  unlicensed: configured[1]!,
  /** A jurisdiction that is not an operating state: telehealth refused even if a clinician is licensed there. */
  closed: configured[2]!,
} as const;

export const ALL_FIXTURE_STATES: readonly string[] = [
  FIXTURE_STATES.licensed,
  FIXTURE_STATES.unlicensed,
  FIXTURE_STATES.closed,
];

/** Inserts the fixture jurisdictions (reference data) through a superuser-capable client. */
export async function seedFixtureJurisdictions(
  sa: { query(sql: string, params: unknown[]): Promise<unknown> },
  orgId: string,
): Promise<void> {
  for (const code of ALL_FIXTURE_STATES)
    await sa.query(
      `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [code, orgId, `Fixture state ${code}`],
    );
}
