// Aggregate gate. NEEDS_JSON is toJSON(needs). Anything other than "success" (failure, cancelled,
// skipped) fails: a skipped required job is a failure, not a pass.
const needs = JSON.parse(process.env.NEEDS_JSON ?? '{}');
const names = Object.keys(needs);
if (names.length === 0) {
  console.error('::error::no needs recorded; the aggregate gate must depend on every required job');
  process.exit(1);
}
const bad = names.filter((n) => needs[n].result !== 'success');
for (const n of names) console.log(`${n}: ${needs[n].result}`);
if (bad.length > 0) {
  console.error(`::error::required job(s) not successful: ${bad.join(', ')}`);
  process.exit(1);
}
