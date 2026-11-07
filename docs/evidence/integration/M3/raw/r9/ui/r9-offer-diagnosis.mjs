// Diagnostic only (read-only, rolls back): replays the offer for the freed slot as app_worker in a patients-scope job. usage: node r9-offer-diagnosis.mjs <repoRoot>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const pg = createRequire(root + '/package.json')('pg');
const imp = (p) => import(pathToFileURL(`${root}/${p}`).href);
const ORG = '00000000-0000-7000-8000-0000000000a1';
const u = new URL(process.env.EHR_TEST_ADMIN_URL); u.pathname = '/ehr_int02_r9_ui';
const adm = new pg.Client({ connectionString: u.toString() }); await adm.connect();
const occ = (await adm.query(`SELECT o.id FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id=o.id WHERE r.service_id='00000000-0000-7000-8000-000000000302'`)).rows[0].id; await adm.end();
const w = new URL(process.env.EHR_TEST_ADMIN_URL); w.username = 'app_worker'; w.password=''; w.pathname = '/ehr_int02_r9_ui';
const { KernelDb, Queue, createLogger } = await imp('packages/kernel/dist/index.js');
const pool = new pg.Pool({ connectionString: w.toString(), max: 2 });
const db = new KernelDb(pool);
const { buildWorkerRegistry } = await imp('apps/worker/dist/job-registry.js');
const { loadApiPorts } = await imp('apps/worker/dist/compose.js');
const sch = await imp('apps/worker/dist/jobs/scheduling/index.js');
const log = createLogger({ sink: () => {} });
const registry = buildWorkerRegistry(); const queue = new Queue(registry, 'worker');
const api = await loadApiPorts({ log, registry, queue, patientHost: '127.0.0.1', qrKey: 'x'.repeat(48) });
const flow = api.scheduling;
const slot = await db.withScope(sch.systemScope(ORG), (tx) => flow.freedSlot(tx, occ));
console.log('freedSlot', slot);
if (slot) {
  const c = await db.withScope(sch.systemScope(ORG), (tx) => flow.candidates(tx, slot));
  console.log('candidates', c);
  for (const cand of c) {
    try {
      // dry-run inside a transaction that we roll back
      const r = await db.withScope(sch.patientsScope(ORG, [cand.patientId]), async (tx) => { const r = await flow.offerToCandidate(tx, { requestId: '00000000-0000-7000-8000-0000000000ff', jobId: 'r9-debug' }, slot, cand); throw Object.assign(new Error('rollback'), { r }); });
    } catch (e) { console.log('offerToCandidate ->', e.r ?? e); }
  }
}
for (const [label, scope] of [['patients-scope', sch.patientsScope(ORG, ['00000000-0000-7000-8000-000000000601'])], ['org-scope', sch.systemScope(ORG)]]) {
  const out = await db.withScope(scope, async (tx) => {
    const o = {};
    for (const t of ['scheduling.availability_template','scheduling.template_rule','organisation.service_clinician','organisation.service_location','organisation.location','identity.principal'])
      o[t] = (await tx.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return o;
  });
  console.log(label, JSON.stringify(out));
}
await pool.end();
