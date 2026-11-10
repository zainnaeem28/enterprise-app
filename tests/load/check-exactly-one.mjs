#!/usr/bin/env node
// TC-PERF-07 / TC-BK-13..15: after perf-07-booking-race.js, count active reservations per raced slot straight from the database
// (read-only SQL) and compare with the expected winner count (1; 2 for the overbookable cap-2 variant). Any other count fails.
// usage: node check-exactly-one.mjs --ids ids.json --expect 1 --out exactly-one.json   (needs LOADTEST_RO_DATABASE_URL)
import fs from 'node:fs';
import { query } from './lib/psql.mjs';
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const expect = Number(arg('expect', 1));
const ids = JSON.parse(fs.readFileSync(arg('ids'), 'utf8'));
const uuid = /^[0-9a-f-]{36}$/;
const rounds = [];
for (const [i, slot] of ids.raceSlots.entries()) {
  if (
    ![slot.clinicianId, slot.locationId].every((v) => uuid.test(v)) ||
    Number.isNaN(Date.parse(slot.startsAt))
  )
    throw new Error(`race slot ${i} is malformed`);
  const [[n]] = query(
    `select count(*) from scheduling.slot_occupancy where clinician_principal_id = '${slot.clinicianId}' and location_id = '${slot.locationId}' and lower(period) = '${slot.startsAt}'::timestamptz and status in ('confirmed','checked_in','in_consultation','completed')`,
  );
  rounds.push({ round: i, found: Number(n), ok: Number(n) === expect });
}
const bad = rounds.filter((r) => !r.ok);
const out = {
  expect,
  rounds: rounds.length,
  wrong: bad,
  pass: bad.length === 0 && rounds.length > 0,
};
fs.writeFileSync(arg('out', 'exactly-one.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
