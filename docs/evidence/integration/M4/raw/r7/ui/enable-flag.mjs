// Disclosed SQL: turns the organisation flag patient_messaging (D-5, default off) on, as a superuser stand-in for the admin screen.
import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const pg = createRequire(process.argv[2] + '/package.json')('pg');
const u = new URL(process.env.EHR_TEST_ADMIN_URL); u.pathname = '/ehr_int02_r12_ui';
const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
await c.query(`INSERT INTO organisation.feature_flag (id, organisation_id, key, location_id, enabled) VALUES ($1,'00000000-0000-7000-8000-0000000000a1','patient_messaging',NULL,true)`, [randomUUID()]);
await c.end(); console.log('flag enabled');
