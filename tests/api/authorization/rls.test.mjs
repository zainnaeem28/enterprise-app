// TC-AZ-05..08 and TC-AZ-13 (TEST-CASES 6): the database roles, row-level security, definer functions and the role x capability
// grid, on ENV-INT/ci (throwaway PostgreSQL 17 with the real migrations and the real roles). Each case connects DIRECTLY as the
// named role; the API-only cases are authorization.test.mjs. Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  login,
  anonymous,
  newPatient,
  sql,
  closeAdmin,
  ORG,
  A1,
  B1,
  principalId,
  clinical,
} from '../identity/lib/ctx.mjs';
import { newAdmin, newRole, AD } from '../security/lib/admins.mjs';
import { asScope, asOwner, attempt, relations, isPhi } from './lib/db.mjs';

after(() => closeAdmin());
const PAT01 = '00000000-0000-7000-8000-000000100003';
const PHI_SCHEMAS = [
  'audit',
  'calendar_sync',
  'clinical',
  'documents',
  'identity',
  'integration_core',
  'messaging',
  'notifications',
  'organisation',
  'patient',
  'privacy',
  'scheduling',
  'telehealth',
];

describe('TC-AZ database roles, RLS and definer functions', () => {
  test('TC-AZ-05 PUBLIC and the limited application context get nothing from PHI tables; reporting_ro is refused on every PHI table, view and read model', async () => {
    const rels = (await relations()).filter((r) => PHI_SCHEMAS.includes(r.schema) && isPhi(r));
    assert.ok(rels.length > 50, `the PHI relation inventory is complete (${rels.length})`);
    // PUBLIC holds no privilege on any of them (catalog)
    const pub = await sql(
      `SELECT n.nspname||'.'||c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0 AND c.relkind IN ('r','p','v','m') AND n.nspname = ANY($1)`,
      [PHI_SCHEMAS],
    );
    assert.deepEqual(pub.rows, [], 'PUBLIC has no privilege on any PHI relation');
    // reporting_ro: SELECT on each relation; refused (42501) everywhere outside reporting
    const refused = [];
    const allowed = [];
    await asScope('reporting_ro', { 'app.org_id': ORG, 'app.audience': 'system' }, async (c) => {
      for (const r of rels) {
        const x = await attempt(c, `SELECT * FROM ${r.schema}."${r.name}" LIMIT 1`);
        (x.ok ? allowed : refused).push({ rel: `${r.schema}.${r.name}`, code: x.code });
      }
    });
    assert.deepEqual(allowed, [], 'reporting_ro can read no PHI table, view or read model');
    assert.ok(
      refused.every((x) => x.code === '42501'),
      `every refusal is "permission denied" (42501), not an error of another kind: ${JSON.stringify(refused.filter((x) => x.code !== '42501').slice(0, 3))}`,
    );
    // its own read models contain no patient identifier column
    const cols = await sql(
      `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='reporting' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','v','m','p') AND a.attname ~* '(patient|given|family|name|dob|birth|mrn|phone|email|address)'`,
    );
    assert.deepEqual(
      cols.rows,
      [],
      'the reporting read models carry no patient identifier or contact column',
    );
    const okRead = await asScope(
      'reporting_ro',
      { 'app.org_id': ORG, 'app.audience': 'system' },
      async (c) => attempt(c, `SELECT * FROM reporting.ops_queue LIMIT 1`),
    );
    assert.equal(okRead.ok, true, 'positive control: reporting_ro reads its own read model');
    // the limited application context: the API login role with no principal (anonymous) and with a patient scope that holds nothing
    const empty = { 'app.org_id': ORG, 'app.audience': 'anonymous' };
    const patientNone = {
      'app.org_id': ORG,
      'app.audience': 'patient',
      'app.realm': 'patient_pool',
      'app.principal_id': randomUUID(),
      'app.patient_ids': randomUUID(),
    };
    const phiTables = rels.filter(
      (r) =>
        r.kind !== 'v' &&
        [
          'patient',
          'clinical',
          'documents',
          'messaging',
          'privacy',
          'telehealth',
          'scheduling',
          'calendar_sync',
        ].includes(r.schema),
    );
    assert.ok(phiTables.length > 20, `the C2/C3 table inventory is complete (${phiTables.length})`);
    for (const [name, ctx] of [
      ['anonymous', empty],
      ['patient with no linked patient', patientNone],
    ]) {
      const leaked = [];
      await asScope('app_api', ctx, async (c) => {
        for (const r of phiTables) {
          const x = await attempt(c, `SELECT count(*)::int AS n FROM ${r.schema}."${r.name}"`);
          if (x.ok && x.rows[0].n > 0) leaked.push(`${r.schema}.${r.name}=${x.rows[0].n}`);
        }
      });
      assert.deepEqual(leaked, [], `${name}: no PHI row is readable`);
    }
    // positive control for the scope: a staff context at the right location does read patients (RLS is not simply closed)
    const seen = await asScope(
      'app_api',
      {
        'app.org_id': ORG,
        'app.audience': 'staff',
        'app.realm': 'google',
        'app.principal_id': principalId('STF-FD-A'),
        'app.location_ids': A1,
      },
      async (c) => attempt(c, `SELECT count(*)::int n FROM patient.patient`),
    );
    assert.ok(
      seen.ok && seen.rows[0].n > 0,
      'positive control: a staff scope at LOC-A1 reads patient rows',
    );
    // directory_ro: column grants only, exactly the C0 columns of the nine directory views (ARCHITECTURE 22.5.1)
    const DIRECTORY = {
      'organisation.location':
        'id,organisation_id,name,kind,time_zone,address,state_code,geo,phone,active',
      'organisation.opening_hours': 'organisation_id,location_id,weekday,opens,closes',
      'organisation.holiday': 'organisation_id,location_id,date,name',
      'organisation.service': 'id,organisation_id,patient_display_name,duration_min,mode,active',
      'organisation.service_location': 'organisation_id,service_id,location_id',
      'organisation.service_clinician': 'organisation_id,service_id,clinician_principal_id',
      'organisation.banner': 'id,organisation_id,surface,message,starts_at,ends_at',
      'identity.principal': 'id,organisation_id,realm,status',
      'identity.staff_profile': 'principal_id,organisation_id,display_name,directory_listed',
      'scheduling.availability_template':
        'organisation_id,clinician_principal_id,location_id,valid_to,status',
    };
    const granted = await sql(
      `SELECT n.nspname||'.'||c.relname AS t, (SELECT string_agg(a.attname::text, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('directory_ro', c.oid, a.attnum, 'SELECT')) AS cols FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`,
    );
    assert.deepEqual(
      Object.fromEntries(granted.rows.filter((x) => x.cols).map((x) => [x.t, x.cols])),
      DIRECTORY,
      'directory_ro holds exactly the C0 column grants',
    );
    await asOwner('directory_ro', { 'app.org_id': ORG, 'app.audience': 'public' }, async (c) => {
      for (const q of [
        'SELECT internal_name FROM organisation.service LIMIT 1',
        'SELECT mrn FROM patient.patient LIMIT 1',
        'SELECT email FROM identity.principal LIMIT 1',
        'SELECT * FROM identity.staff_profile LIMIT 1',
      ])
        assert.equal((await attempt(c, q)).code, '42501', `${q} is refused`);
    });
  });

  test('TC-AZ-06 each function-owner role reaches only its allow-listed columns; M-5 catalog: FORCE RLS everywhere, role-targeted policies, owner-rights views only where designed', async () => {
    const roles = [
      'patient_match_owner',
      'scheduling_booking_owner',
      'patient_scope_owner',
      'integration_receiver_owner',
      'identity_bootstrap_owner',
      'identity_signin_ro',
    ];
    // The allow-list is the design (SHARED-BOUNDARIES 6.2 / ARCHITECTURE 21.6): relation -> columns the owner may read.
    const ALLOW = {
      patient_match_owner: {
        'patient.patient': [
          'id',
          'organisation_id',
          'mrn',
          'given_name',
          'family_name',
          'middle_name',
          'date_of_birth',
          'phone_e164',
          'email',
          'status',
          'merged_into',
        ],
        'patient.match_check': '*',
        'patient.patient_merge': '*',
        'patient.staff_scope': '*',
      },
      scheduling_booking_owner: {
        'organisation.booking_policy': [
          'organisation_id',
          'location_id',
          'overbook_cap_per_session',
        ],
        'scheduling.busy_block': '*',
        'scheduling.slot_occupancy': '*',
        'scheduling.slot_reservation': ['id', 'organisation_id', 'patient_id', 'location_id'],
      },
    };
    for (const role of roles) {
      const q = await sql(
        `SELECT n.nspname||'.'||c.relname AS rel, has_table_privilege($1, c.oid, 'SELECT') AS whole,
                (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege($1, c.oid, a.attnum, 'SELECT')) AS cols
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','kernel','queue','queue_api','migration')`,
        [role],
      );
      const reach = q.rows.filter((r) => r.cols?.length);
      if (ALLOW[role]) {
        for (const r of reach) {
          const al = ALLOW[role][r.rel];
          assert.ok(al, `${role} may not read ${r.rel} at all`);
          if (al !== '*')
            assert.deepEqual(
              r.cols.filter((c) => !al.includes(c)),
              [],
              `${role} reads only the allow-listed columns of ${r.rel}`,
            );
        }
      }
      // behaviour: SET ROLE and read every relation; whatever is not granted is refused
      const notGranted = [];
      await asOwner(
        role,
        {
          'app.org_id': ORG,
          'app.audience': 'staff',
          'app.realm': 'google',
          'app.location_ids': A1,
        },
        async (c) => {
          for (const r of q.rows.filter((x) => !x.cols?.length)) {
            const x = await attempt(c, `SELECT * FROM ${r.rel} LIMIT 1`);
            if (x.ok) notGranted.push(r.rel);
            else assert.equal(x.code, '42501', `${role} on ${r.rel}: ${x.code}`);
          }
        },
      );
      assert.deepEqual(notGranted, [], `${role}: a relation outside its grants is refused`);
    }
    // patient_match_owner: identity columns only; SELECT * is refused
    await asOwner(
      'patient_match_owner',
      { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'google', 'app.location_ids': A1 },
      async (c) => {
        assert.equal(
          (
            await attempt(
              c,
              `SELECT id, given_name, family_name, date_of_birth FROM patient.patient LIMIT 1`,
            )
          ).ok,
          true,
          'positive control: identity columns',
        );
        const star = await attempt(c, `SELECT * FROM patient.patient LIMIT 1`);
        assert.equal(
          star.code,
          '42501',
          'a non-identity column (e.g. sex, address, notes) is refused',
        );
        for (const col of ['sex_at_birth', 'gender_identity', 'created_via'])
          assert.equal(
            (await attempt(c, `SELECT ${col} FROM patient.patient LIMIT 1`)).code,
            '42501',
            `${col} is refused`,
          );
      },
    );
    // scheduling_booking_owner sees only the booking (C1) rows: no clinical table
    await asOwner(
      'scheduling_booking_owner',
      { 'app.org_id': ORG, 'app.audience': 'staff', 'app.realm': 'google', 'app.location_ids': A1 },
      async (c) => {
        for (const t of [
          'clinical.encounter',
          'clinical.note',
          'patient.patient',
          'documents.document',
        ])
          assert.equal(
            (await attempt(c, `SELECT 1 FROM ${t} LIMIT 1`)).code,
            '42501',
            `${t} refused`,
          );
      },
    );
    // M-5 catalog checks
    const rels = await relations();
    const noForce = rels
      .filter((r) => ['r', 'p'].includes(r.kind) && !r.forced && r.schema !== 'migration')
      .map((r) => `${r.schema}.${r.name}`);
    assert.deepEqual(
      noForce,
      [],
      'FORCE ROW LEVEL SECURITY on every table (migration.schema_migration is the one designed exception)',
    );
    const publicPolicies = await sql(
      `SELECT schemaname||'.'||tablename t, policyname FROM pg_policies WHERE 'public' = ANY(roles)`,
    );
    assert.deepEqual(
      publicPolicies.rows,
      [],
      'every policy is role-targeted (none applies to PUBLIC)',
    );
    const views = await sql(
      `SELECT n.nspname||'.'||c.relname v, pg_get_userbyid(c.relowner) owner, coalesce('security_invoker=true' = ANY(c.reloptions), false) invoker FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    );
    const bad = views.rows.filter(
      (v) => !v.invoker && !['directory_ro', 'queue_owner'].includes(v.owner),
    );
    assert.deepEqual(
      bad,
      [],
      'every view is security_invoker, except the nine directory views owned by directory_ro and the queue library view',
    );
    const dirViews = views.rows
      .filter((v) => v.owner === 'directory_ro')
      .map((v) => v.v)
      .sort();
    assert.equal(dirViews.length, 9, `exactly nine directory views (${dirViews.join(', ')})`);
  });

  test('TC-AZ-07 definer functions refuse callers outside their audience and never return out-of-scope demographics', async () => {
    const fns = (
      await sql(
        `SELECT n.nspname AS s, p.proname AS name, array_to_string(p.proargtypes::oid[]::regtype[], ',') AS types, has_function_privilege('app_api', p.oid, 'EXECUTE') AS api, has_function_privilege('app_worker', p.oid, 'EXECUTE') AS wrk
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE p.prosecdef AND p.prorettype <> 'trigger'::regtype AND n.nspname NOT IN ('pg_catalog','information_schema') AND p.proname NOT IN ('enqueue', 'receive_inbound')
            AND (has_function_privilege('app_api', p.oid, 'EXECUTE') OR has_function_privilege('app_worker', p.oid, 'EXECUTE')) ORDER BY 1, 2`,
      )
    ).rows;
    // integration_core.receive_inbound is excluded: its audience IS the anonymous webhook; the API verifies the signature before calling it
    // (ARCHITECTURE 25.7, DF-3). The function itself checks no audience, so there is no refusal to assert.
    assert.ok(fns.length >= 20, `the definer inventory is complete (${fns.length})`);
    const value = (t) => {
      switch (t) {
        case 'uuid':
          return randomUUID();
        case 'uuid[]':
          return [randomUUID()];
        case 'text':
          return 'x';
        case 'boolean':
          return false;
        case 'date':
          return '1980-01-01';
        case 'jsonb':
          return '{}';
        case 'bytea':
          return randomBytes(32);
        case 'bytea[]':
          return [randomBytes(32)];
        case 'integer':
        case 'smallint':
        case 'bigint':
          return 1;
        case 'tstzrange':
          return '[2031-01-01,2031-01-02)';
        case 'tstzrange[]':
          return ['[2031-01-01,2031-01-02)'];
        default:
          throw new Error(`no dummy value for ${t}`);
      }
    };
    const secrets = (
      await sql(`SELECT given_name, family_name, mrn, email FROM patient.patient LIMIT 40`)
    ).rows
      .flatMap((r) => [r.family_name, r.mrn, r.email])
      .filter((x) => x && x.length > 6);
    const contexts = {
      anonymous: { 'app.org_id': ORG, 'app.audience': 'anonymous' },
      public: { 'app.org_id': ORG, 'app.audience': 'public' },
      patient: {
        'app.org_id': ORG,
        'app.audience': 'patient',
        'app.realm': 'patient_pool',
        'app.principal_id': randomUUID(),
        'app.patient_ids': randomUUID(),
      },
      admin_no_key: {
        'app.org_id': ORG,
        'app.audience': 'staff',
        'app.realm': 'admin_pool',
        'app.principal_id': randomUUID(),
      },
      staff_other_location: {
        'app.org_id': ORG,
        'app.audience': 'staff',
        'app.realm': 'google',
        'app.principal_id': principalId('STF-FD-B'),
        'app.location_ids': B1,
      },
    };
    const problems = [];
    let calls = 0;
    for (const f of fns) {
      const types = f.types.split(',').filter(Boolean);
      const args = types.map(value);
      const call = `SELECT * FROM ${f.s}.${f.name}(${types.map((t, i) => `$${i + 1}::${t}`).join(',')})`;
      for (const role of [f.api && 'app_api', f.wrk && 'app_worker'].filter(Boolean)) {
        for (const [cname, ctx] of Object.entries(contexts)) {
          // the intended audiences of a function are not "outside": skip only the combination the function is built for
          if (['patient.register'].includes(`${f.s}.${f.name}`) && cname === 'patient') continue;
          const x = await asScope(role, ctx, (c) => attempt(c, call, args));
          calls++;
          if (!x.ok) continue; // refused or invalid: nothing returned
          const flat = JSON.stringify(x.rows);
          const hit = secrets.find((s) => flat.includes(s));
          const nonEmpty = x.rows.some((r) =>
            Object.values(r).some(
              (v) =>
                v !== null &&
                v !== false &&
                v !== 0 &&
                !(Array.isArray(v) && v.length === 0) &&
                !(typeof v === 'object' && v && Object.keys(v).length === 0),
            ),
          );
          if (hit || nonEmpty)
            problems.push(`${f.s}.${f.name} as ${role}/${cname}: ${flat.slice(0, 120)}`);
        }
      }
      // a role that does NOT hold EXECUTE is refused at the door
      for (const role of [!f.api && 'app_api', !f.wrk && 'app_worker'].filter(Boolean)) {
        const x = await asScope(role, contexts.staff_other_location, (c) => attempt(c, call, args));
        calls++;
        assert.equal(x.ok, false, `${f.s}.${f.name} must not run as ${role}`);
        assert.equal(
          x.code,
          '42501',
          `${f.s}.${f.name} as ${role}: permission denied expected, got ${x.code}`,
        );
      }
    }
    assert.deepEqual(
      problems,
      [],
      `no definer function returned data to a caller outside its audience (${calls} calls)`,
    );
    // the match functions with REAL values of a real patient, from callers that must not see it
    const p1 = (
      await sql(
        `SELECT given_name g, family_name f, date_of_birth::text d, phone_e164 ph, email e, mrn FROM patient.patient WHERE id = $1`,
        [PAT01],
      )
    ).rows[0];
    const real = [randomUUID(), p1.g, p1.f, p1.d, p1.ph, p1.e, randomBytes(32), A1];
    const matchSql = `SELECT patient.match_candidates($1::uuid,$2::text,$3::text,$4::date,$5::text,$6::text,$7::bytea,$8::uuid) AS m`;
    const staffA = {
      'app.org_id': ORG,
      'app.audience': 'staff',
      'app.realm': 'google',
      'app.principal_id': principalId('STF-FD-A'),
      'app.location_ids': A1,
    };
    const control = await asScope('app_api', staffA, (c) => attempt(c, matchSql, real));
    assert.ok(
      control.ok,
      `positive control: a front-desk scope at LOC-A1 may run the match (${control.code} ${control.message})`,
    );
    assert.ok(
      JSON.stringify(control.rows).includes(PAT01),
      'positive control: the in-scope caller is told which patient matched',
    );
    for (const [name, ctx] of Object.entries({
      ...contexts,
      staff_other_location_real: { ...contexts.staff_other_location, 'app.location_ids': B1 },
    })) {
      const x = await asScope('app_api', ctx, (c) =>
        attempt(c, matchSql, [real[0], real[1], real[2], real[3], real[4], real[5], real[6], B1]),
      );
      if (x.ok) {
        const flat = JSON.stringify(x.rows);
        for (const s of [p1.f, p1.mrn, p1.e, p1.ph, p1.d, PAT01])
          assert.ok(!flat.includes(String(s)), `${name}: the match function leaked ${s}`);
      }
    }
  });

  test('TC-AZ-08 a compliance principal holding only privacy.request.manage sees no audit event, consent or incident; identity_label needs the key, a visible referencing record and is rate limited', async () => {
    const role = await newRole(['privacy.request.manage']);
    const cmp3 = await newAdmin({ roles: [role], name: 'CMP3', elevated: true });
    const labelRole = await newRole(['patient.label.read']);
    const lab = await newAdmin({ roles: [labelRole], name: 'LBL', elevated: true });
    const pat = await newPatient();
    // an audit event, a consent record and an incident exist
    await clinical
      .consentRow({ id: pat.id }, `qa03-c-${randomUUID().slice(0, 6)}`, 1, 'signed')
      .catch(async () => {
        const key = await clinical.publishConsent();
        await clinical.consentRow({ id: pat.id }, key, 1, 'signed');
      });
    const inc = randomUUID();
    await sql(
      `INSERT INTO privacy.incident (id, organisation_id, title, description, severity, discovered_at) VALUES ($1,$2,'QA03 synthetic incident','synthetic','low', now())`,
      [inc, ORG],
    );
    const ev = await sql(`SELECT count(*)::int n FROM audit.event`);
    assert.ok(ev.rows[0].n > 0, 'setup: audit events exist');
    // 1. SQL under the settings the API would set for this principal (admin_pool, limited PHI access, its one slice key)
    const scope = {
      'app.org_id': ORG,
      'app.audience': 'staff',
      'app.realm': 'admin_pool',
      'app.principal_id': cmp3.principalId,
      'app.person_id': cmp3.personId,
      'app.phi_access': 'limited',
      'app.compliance_scopes': 'privacy_requests',
    };
    const counts = await asScope('app_api', scope, async (c) => {
      const out = {};
      for (const t of ['audit.event', 'patient.consent', 'privacy.incident', 'privacy.request']) {
        const x = await attempt(c, `SELECT count(*)::int n FROM ${t}`);
        out[t] = x.ok ? x.rows[0].n : x.code;
      }
      return out;
    });
    assert.ok(
      [0, '42501'].includes(counts['audit.event']),
      `audit events: ${counts['audit.event']}`,
    );
    assert.ok(
      [0, '42501'].includes(counts['patient.consent']),
      `consents: ${counts['patient.consent']}`,
    );
    assert.ok(
      [0, '42501'].includes(counts['privacy.incident']),
      `incidents: ${counts['privacy.incident']}`,
    );
    // 2. the same through the API
    for (const p of ['/audit-events/search', '/consents', '/incidents', '/btg-grants']) {
      const r = p.endsWith('search')
        ? await cmp3.client.post(`${AD}${p}`, {
            from: new Date(Date.now() - 36e5).toISOString(),
            to: new Date().toISOString(),
          })
        : await cmp3.client.get(`${AD}${p}`);
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    }
    // 3. identity_label: refused without the slice key (direct), refused without a visible referencing record, audited per call, rate limited
    const call = `SELECT patient.identity_label($1::uuid, $2::uuid, 'privacy.request', $3::uuid) AS l`;
    const withoutKey = await asScope('app_api', scope, (c) =>
      attempt(c, call, [randomUUID(), pat.id, randomUUID()]),
    );
    assert.equal(
      withoutKey.code,
      '42501',
      `identity_label without the patient_label key: ${withoutKey.code}`,
    );
    const direct = await lab.client.post(`${AD}/patient-labels`, {
      patientId: pat.id,
      referenceType: 'privacy.request',
      referenceId: randomUUID(),
    });
    assert.ok(
      [403, 404, 422, 400].includes(direct.status) && !/givenName|familyName|mrn/.test(direct.text),
      `no visible referencing record -> refused (${direct.status} ${direct.text.slice(0, 100)})`,
    );
    const noKey = await cmp3.client.post(`${AD}/patient-labels`, {
      patientId: pat.id,
      referenceType: 'privacy.request',
      referenceId: randomUUID(),
    });
    assert.equal(noKey.status, 403, 'CMP-3 holds no label permission');
    let limited;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await lab.client.post(`${AD}/patient-labels`, {
        patientId: pat.id,
        referenceType: 'privacy.request',
        referenceId: randomUUID(),
      });
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'repeated label calls hit the per-hour limit (429)');
    assert.ok(limited.headers['retry-after'], '429 carries Retry-After');
  });

  test('TC-AZ-13 role x capability grid: every cell matches the 27.3 matrix, and a route grid is refused or allowed cell by cell', async () => {
    // The matrix (ARCHITECTURE 27.3, the BA matrix Appendix C 1.1, read literally; wildcard rows expanded).
    const FD = [
      'patient.read',
      'patient.register',
      'patient.update',
      'patient.match',
      'patient.insurance.verify',
      'scheduling.availability.search',
      'scheduling.booking.manage',
      'scheduling.check_in',
      'scheduling.queue.manage',
      'scheduling.waitlist.manage',
      'documents.upload',
      'documents.read',
      'documents.classify',
      'clinical.chart.read_previsit',
      'messaging.thread.staff',
      'messaging.task.manage',
      'privacy.request.create_for_patient',
      'notifications.alert.read',
      'notifications.alert.acknowledge',
    ];
    const MSG = ['messaging.thread.staff', 'messaging.thread.patient', 'messaging.task.manage'];
    const DOCTOR = [
      'clinical.chart.read',
      'clinical.chart.read_previsit',
      'clinical.consultation.start',
      'clinical.list.write',
      'clinical.note.cosign',
      'clinical.note.sign',
      'clinical.note.write',
      'clinical.referral.manage',
      'clinical.terminology.search',
      'clinical.triage.record',
      'clinical.vitals.record',
      'clinical.alert.red_flag.receive',
      'audit.btg.open',
      'scheduling.booking.own_schedule',
      'scheduling.template.manage',
      'scheduling.blocked_time.manage',
      'calendar.link.own',
      'telehealth.session.host',
      ...MSG,
      'documents.read',
      'documents.upload',
      'patient.lookup',
      'notifications.alert.read',
      'notifications.alert.acknowledge',
    ];
    const MATRIX = {
      'STF-FD-A': FD,
      'STF-TRI-A': [
        'patient.read',
        'scheduling.availability.search',
        'documents.read',
        'notifications.alert.read',
        'notifications.alert.acknowledge',
        'clinical.vitals.record',
        'clinical.triage.record',
        'clinical.chart.read_previsit',
        'clinical.alert.red_flag.receive',
      ],
      'STF-COORD-A': [
        'scheduling.booking.manage',
        'scheduling.waitlist.manage',
        'clinical.referral.manage',
        ...MSG,
        'clinical.chart.read_previsit',
      ],
      'STF-DR-A1': DOCTOR,
      'STF-TRN-A': DOCTOR.filter((p) => !['clinical.note.sign', 'audit.btg.open'].includes(p)),
      'STF-MRO-A': [
        'patient.read',
        'patient.merge.request',
        'patient.merge.approve',
        'documents.read',
        'documents.classify',
        'documents.legal_hold.manage',
        'documents.deletion.decide',
      ],
      'STF-ASST-A': ['clinical.note.write', 'clinical.list.write', 'clinical.chart.read'],
      'STF-BILL-A': [],
    };
    const universe = (await sql(`SELECT key FROM identity.permission ORDER BY key`)).rows.map(
      (r) => r.key,
    );
    const cells = new Map();
    const sessions = {};
    for (const persona of Object.keys(MATRIX)) {
      sessions[persona] = await login('staff', persona);
      assert.equal(sessions[persona].sessionStatus, 200, `${persona} signs in`);
      const have = new Set(sessions[persona].session.permissions);
      for (const perm of universe)
        cells.set(`${persona}|${perm}`, {
          expected: MATRIX[persona].includes(perm),
          actual: have.has(perm),
        });
      for (const perm of MATRIX[persona])
        assert.ok(universe.includes(perm), `${perm} is a known permission`);
    }
    const wrong = [...cells]
      .filter(([, v]) => v.expected !== v.actual)
      .map(([k, v]) => `${k} expected ${v.expected} actual ${v.actual}`);
    assert.deepEqual(
      wrong,
      [],
      `every role x permission cell matches the matrix (${cells.size} cells)`,
    );
    assert.equal(cells.size, Object.keys(MATRIX).length * universe.length, 'no cell is missing');
    // Admin roles: the matrix rows for org_admin and compliance_officer, read from the API's own role listing and compared with 27.3
    const adm = await newAdmin({ roles: ['org_admin'], name: 'GRID-ADM', elevated: true });
    const cmp = await newAdmin({ roles: ['compliance_officer'], name: 'GRID-CMP', elevated: true });
    const admPerms = new Set((await adm.client.get('/api/v1/auth/session')).json.permissions);
    const cmpPerms = new Set((await cmp.client.get('/api/v1/auth/session')).json.permissions);
    for (const p of [...admPerms])
      assert.ok(
        /^(organisation|identity|integration|notifications|reporting|scheduling|clinical\.vital_range)\./.test(
          p,
        ),
        `org_admin holds ${p}: allowed by 27.3 (organisation.*, identity.*, integration.*, ...)`,
      );
    for (const p of [
      'audit.event.read',
      'audit.export.create',
      'audit.btg.review',
      'patient.consent.read',
      'patient.label.read',
      'privacy.request.manage',
      'privacy.incident.manage',
    ])
      assert.ok(!admPerms.has(p), `org_admin must NOT hold ${p} (27.3: compliance only)`);
    for (const p of [...cmpPerms])
      assert.ok(
        /^(audit|patient\.(consent|label)|privacy|reporting|notifications)\./.test(p),
        `compliance_officer holds ${p}: allowed by 27.3`,
      );
    for (const p of [
      'identity.role_change.request',
      'identity.principal.kill',
      'organisation.setting.write',
    ])
      assert.ok(!cmpPerms.has(p), `compliance_officer must NOT hold ${p}`);
    // The route grid: for every persona x route, an allowed cell is NOT refused by the permission guard and a "-" cell is refused (403).
    const u = randomUUID();
    const ROUTES = [
      ['patient.read', 'POST', '/api/v1/patients/search', { name: 'zz' }],
      ['patient.lookup', 'POST', '/api/v1/patients/lookup', { name: 'zz' }],
      ['patient.match', 'GET', '/api/v1/duplicate-flags?locationId=' + A1],
      ['scheduling.availability.search', 'POST', '/api/v1/availability/search', {}],
      ['notifications.alert.read', 'GET', '/api/v1/alerts'],
      ['clinical.consultation.start', 'POST', '/api/v1/encounters', {}],
      ['clinical.note.cosign', 'POST', `/api/v1/notes/${u}/cosign`, {}],
      ['clinical.list.write', 'POST', `/api/v1/patients/${u}/problems`, {}],
      ['patient.attach', 'POST', `/api/v1/patients/${u}/attach`, {}],
      ['patient.merge.request', 'POST', '/api/v1/patient-merges', {}],
      ['documents.legal_hold.manage', 'POST', `/api/v1/documents/${u}/legal-holds`, {}],
      ['privacy.request.create_for_patient', 'POST', `/api/v1/patients/${u}/privacy-requests`, {}],
      ['messaging.thread.staff', 'GET', '/api/v1/threads'],
    ];
    const grid = [];
    for (const persona of Object.keys(MATRIX)) {
      const c = sessions[persona];
      const has = new Set(c.session.permissions);
      for (const [perm, method, path, body] of ROUTES) {
        const r =
          method === 'GET'
            ? await c.get(path)
            : await c.post(path, body ?? {}, { headers: { 'if-match': 'W/"1"' } });
        grid.push({ persona, perm, status: r.status, code: r.json?.code, allowed: has.has(perm) });
      }
    }
    assert.equal(
      grid.length,
      Object.keys(MATRIX).length * ROUTES.length,
      'no cell of the route grid is missing',
    );
    const badCells = grid
      .filter((g) =>
        g.allowed ? g.status === 403 && g.code === 'auth.forbidden' : g.status !== 403,
      )
      .map((g) => `${g.persona} ${g.perm} -> ${g.status} ${g.code}`);
    assert.deepEqual(
      badCells,
      [],
      'every route cell agrees with the matrix (a refusal where a "-" is, no permission refusal where a tick is)',
    );
    // Staff-realm users never reach admin routes
    for (const persona of ['STF-FD-A', 'STF-DR-A1', 'STF-MRO-A']) {
      for (const p of [
        '/api/v1/admin/principals',
        '/api/v1/admin/roles',
        '/api/v1/admin/btg-grants',
        '/api/v1/admin/consents',
      ]) {
        const r = await sessions[persona].get(p);
        assert.ok([401, 403, 404].includes(r.status), `${persona} ${p} -> ${r.status}`);
      }
    }
    void anonymous;
  });
});
