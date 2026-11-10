# TECHNICAL DESIGN SPIKE — PostgreSQL behaviours (HEAAA-13)

| Field | Value |
| --- | --- |
| Task | HEAAA-13 `[SDLC:technical-design]` |
| Author | Solution Architect agent (`7efe9f61-495f-4237-82f9-fa178629da09`) |
| Purpose | Evidence for ARCHITECTURE draft 5, section 38.1. Checks the PostgreSQL behaviours that SHARED-BOUNDARIES draft 3 and Part II rely on |
| Executed | 2026-11-04, in a throwaway scratch directory outside the repository |
| Engine | PGlite 0.5.15 (`@electric-sql/pglite`, npm), which is PostgreSQL 18.6 compiled to WebAssembly, with the `btree_gist` extension; Node.js v24.22.2 |
| Not | RDS for PostgreSQL 17. Not a migration. Not product code. One connection only: **no concurrency, lock-wait, deadlock or `READ COMMITTED` re-read behaviour was tested** |
| Commands | `npm install @electric-sql/pglite@latest`; `node spike.js > spike-out.json`; `node inline2.js > inline2-out.txt` |
| Exit status | `spike.js` exits 1 because 2 of 24 checks are `ok: false`: the two inlining checks, which record that `patient.staff_sees` is not inlined. That is a finding, not a broken run. `inline2.js` exits 0 |

## Hashes (sha256)

```
a1317557a6b6a443b9f2228c08ef945353d1c1325ffb7b573f668bb0e5e157eb  spike.js
3e0b0ffff0d6a19bb7b22af4afd3ebbc2f179a023bd8ef4e626877cafc39ebb0  inline2.js
1dc23c8e491c03982cd80acb405a7e06d440f6cc3513ad6b00144dfa243bfefc  spike-out.json
4b1e887af85ce0ae94209e70aff6b040026d758ce9f63d308d0bc1c9d31e72e2  inline2-out.txt
```

## Findings

1. `patient.staff_sees` (invoker `LANGUAGE sql STABLE` function with an `EXISTS` sub-query) is **not inlined** into an RLS policy, with or without `SET search_path`. The plan shows a per-row function call. The policies therefore use the written-out `EXISTS` from one template (ARCHITECTURE 21.4).
2. The written-out `EXISTS` policy, with 60,000 patients and 180,000 notes, gives an index scan plus an index-only probe of `staff_scope` for a by-patient read, and a hashed sub-plan for a location-wide count (`inline2-out.txt`).
3. Handing a function to a `NOLOGIN` owner role needs the migration role to have `SET` membership in that role, and the owner role to have `CREATE` on the schema (ARCHITECTURE 21.2).
4. `FOR KEY SHARE` on the patient root is refused to a role with only SELECT (ARCHITECTURE 21.2, `patient.lock_patients`).
5. Under `FORCE ROW LEVEL SECURITY` with no owner policy, the table owner's `UPDATE` changes 0 rows and reports success (SBR-17).
6. All other checks passed: see `spike-out.json` below.

## spike.js

```js
// HEAAA-13 design spike: checks PostgreSQL behaviours the technical design relies on.
// Throwaway, single-connection PGlite (PostgreSQL 18.x WASM). Not a migration, not product code.
const { PGlite } = require('@electric-sql/pglite');
const { btree_gist } = require('@electric-sql/pglite/contrib/btree_gist');

const results = [];
function rec(id, ok, detail) { results.push({ id, ok, detail }); }

async function expectError(db, id, sql, pattern) {
  try { await db.exec(sql); rec(id, false, 'no error raised'); }
  catch (e) { const ok = pattern ? new RegExp(pattern).test(e.message) : true; rec(id, ok, e.message.split('\n')[0]); }
  try { await db.exec('ROLLBACK'); } catch (_) {}
}

(async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  const v = (await db.query('select version()')).rows[0].version;
  rec('ENV', true, v.split(' on ')[0]);

  await db.exec(`
    CREATE EXTENSION btree_gist;
    CREATE ROLE app_owner NOLOGIN; CREATE ROLE app_api NOLOGIN; CREATE ROLE app_worker NOLOGIN;
    CREATE ROLE patient_scope_owner NOLOGIN; CREATE ROLE scheduling_booking_owner NOLOGIN; CREATE ROLE reporting_ro NOLOGIN;
    CREATE SCHEMA patient AUTHORIZATION app_owner; CREATE SCHEMA scheduling AUTHORIZATION app_owner; CREATE SCHEMA clinical AUTHORIZATION app_owner;
    GRANT patient_scope_owner, scheduling_booking_owner TO app_owner WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON SCHEMA patient TO patient_scope_owner;
    GRANT USAGE ON SCHEMA patient, scheduling, clinical TO app_api, app_worker, patient_scope_owner, scheduling_booking_owner, reporting_ro;
    SET ROLE app_owner;

    CREATE TABLE patient.patient (
      id uuid PRIMARY KEY, organisation_id uuid NOT NULL, family_name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
      merged_into uuid REFERENCES patient.patient(id),
      CHECK ((status = 'merged') = (merged_into IS NOT NULL)));
    CREATE TABLE patient.staff_scope (patient_id uuid NOT NULL REFERENCES patient.patient(id), location_id uuid NOT NULL,
      organisation_id uuid NOT NULL, PRIMARY KEY (patient_id, location_id));
    CREATE TABLE clinical.note (id uuid PRIMARY KEY, organisation_id uuid NOT NULL,
      patient_id uuid NOT NULL REFERENCES patient.patient(id) ON DELETE RESTRICT, body text NOT NULL, status text NOT NULL DEFAULT 'draft');
    CREATE INDEX note_patient_idx ON clinical.note (patient_id);

    CREATE FUNCTION patient.staff_sees(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
      SET search_path = pg_catalog AS $$
      SELECT EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = p
        AND s.location_id = ANY (string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[])) $$;
    CREATE FUNCTION patient.staff_sees_nosp(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$
      SELECT EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = p
        AND s.location_id = ANY (string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[])) $$;
  `);

  // ---- RLS: FORCE + role-targeted policies
  await db.exec(`
    ALTER TABLE patient.patient ENABLE ROW LEVEL SECURITY; ALTER TABLE patient.patient FORCE ROW LEVEL SECURITY;
    ALTER TABLE patient.staff_scope ENABLE ROW LEVEL SECURITY; ALTER TABLE patient.staff_scope FORCE ROW LEVEL SECURITY;
    ALTER TABLE clinical.note ENABLE ROW LEVEL SECURITY; ALTER TABLE clinical.note FORCE ROW LEVEL SECURITY;
    CREATE POLICY staff_scope_staff ON patient.staff_scope FOR SELECT TO app_api, app_worker
      USING (location_id = ANY (string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[]));
    CREATE POLICY note_staff ON clinical.note FOR ALL TO app_api, app_worker
      USING (current_setting('app.audience', true) = 'staff' AND patient.staff_sees_nosp(patient_id))
      WITH CHECK (current_setting('app.audience', true) = 'staff' AND patient.staff_sees_nosp(patient_id));
    CREATE POLICY patient_staff ON patient.patient FOR SELECT TO app_api, app_worker
      USING (patient.staff_sees_nosp(id));
    CREATE POLICY patient_scope_owner_all ON patient.patient FOR ALL TO patient_scope_owner
      USING (organisation_id::text = current_setting('app.org_id', true)) WITH CHECK (organisation_id::text = current_setting('app.org_id', true));
    CREATE POLICY staff_scope_owner_all ON patient.staff_scope FOR ALL TO patient_scope_owner
      USING (organisation_id::text = current_setting('app.org_id', true)) WITH CHECK (organisation_id::text = current_setting('app.org_id', true));
    GRANT SELECT ON patient.staff_scope TO app_api, app_worker;
    GRANT SELECT, INSERT, UPDATE ON clinical.note TO app_api, app_worker;
    GRANT SELECT (id, organisation_id, family_name, status, merged_into) ON patient.patient TO app_api, app_worker;
    GRANT SELECT, INSERT, UPDATE ON patient.patient, patient.staff_scope TO patient_scope_owner;
    GRANT EXECUTE ON FUNCTION patient.staff_sees(uuid), patient.staff_sees_nosp(uuid) TO app_api, app_worker, patient_scope_owner;
  `);
  // seed as owner: under FORCE with no owner policy this must insert nothing / fail
  await expectError(db, 'M1-owner-forced', `INSERT INTO patient.patient(id, organisation_id, family_name) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000f','X')`, 'row-level security');
  // SBR-17: owner DML under FORCE sees zero rows (UPDATE reports 0)
  await db.exec(`RESET ROLE`);
  // seed as superuser (bypasses RLS) - stands in for a fixture loader
  await db.exec(`
    INSERT INTO patient.patient(id, organisation_id, family_name) VALUES
      ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000f','Alpha'),
      ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000f','Beta');
    INSERT INTO patient.staff_scope VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000f');
    INSERT INTO clinical.note(id, organisation_id, patient_id, body) VALUES
      ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000a1','n1'),
      ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000b1','n2');
  `);
  await db.exec(`SET ROLE app_owner`);
  const ownerUpd = await db.query(`UPDATE clinical.note SET body = body`);
  rec('SBR17-owner-dml-zero-rows', ownerUpd.affectedRows === 0, `app_owner UPDATE under FORCE affected ${ownerUpd.affectedRows} rows`);
  await db.exec(`RESET ROLE`);

  // staff at location c1 sees note for a1 only
  await db.exec(`SET ROLE app_api; SELECT set_config('app.audience','staff',false); SELECT set_config('app.location_ids','00000000-0000-0000-0000-0000000000c1',false);`);
  let r = await db.query(`SELECT patient_id FROM clinical.note ORDER BY id`);
  rec('RLS-staff-scope', r.rows.length === 1 && r.rows[0].patient_id.endsWith('a1'), `staff at c1 sees ${r.rows.length} note(s)`);
  // missing setting fails closed
  await db.exec(`SELECT set_config('app.location_ids','',false)`);
  r = await db.query(`SELECT count(*)::int c FROM clinical.note`);
  rec('RLS-fail-closed', r.rows[0].c === 0, `missing location setting -> ${r.rows[0].c} rows`);
  await db.exec(`SELECT set_config('app.location_ids','00000000-0000-0000-0000-0000000000c1',false)`);
  // WITH CHECK refuses insert for out-of-scope patient
  await expectError(db, 'RLS-withcheck', `INSERT INTO clinical.note(id, organisation_id, patient_id, body) VALUES ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000b1','x')`, 'row-level security');
  await db.exec(`SET ROLE app_api`);

  // ---- Inlining of staff_sees: compare plans with and without SET search_path
  const planNo = (await db.query(`EXPLAIN (COSTS OFF) SELECT id FROM clinical.note`)).rows.map(x => x['QUERY PLAN']).join(' | ');
  rec('INLINE-no-search_path', !/staff_sees/.test(planNo), planNo);
  await db.exec(`RESET ROLE; SET ROLE app_owner;
    ALTER POLICY note_staff ON clinical.note USING (current_setting('app.audience', true) = 'staff' AND patient.staff_sees(patient_id))
      WITH CHECK (current_setting('app.audience', true) = 'staff' AND patient.staff_sees(patient_id));
    RESET ROLE; SET ROLE app_api;`);
  const planSp = (await db.query(`EXPLAIN (COSTS OFF) SELECT id FROM clinical.note`)).rows.map(x => x['QUERY PLAN']).join(' | ');
  rec('INLINE-with-search_path', !/staff_sees/.test(planSp), planSp);
  await db.exec(`RESET ROLE`);

  // ---- security_invoker view
  await db.exec(`SET ROLE app_owner;
    CREATE VIEW clinical.note_list_definer AS SELECT id, patient_id FROM clinical.note;
    CREATE VIEW clinical.note_list_invoker WITH (security_invoker = true) AS SELECT id, patient_id FROM clinical.note;
    GRANT SELECT ON clinical.note_list_definer, clinical.note_list_invoker TO app_api, reporting_ro;
    RESET ROLE; SET ROLE app_api;`);
  const vd = (await db.query(`SELECT count(*)::int c FROM clinical.note_list_definer`)).rows[0].c;
  const vi = (await db.query(`SELECT count(*)::int c FROM clinical.note_list_invoker`)).rows[0].c;
  rec('M4-view-definer-vs-invoker', vi === 1, `definer view (owner app_owner, FORCE) rows=${vd}; invoker view rows=${vi}`);
  await db.exec(`RESET ROLE; SET ROLE reporting_ro`);
  await expectError(db, 'M4-reporting_ro-no-table', `SELECT * FROM clinical.note`, 'permission denied');
  await db.exec(`RESET ROLE`);

  // ---- Merge write guard + root guard (SBR-12, SBR-16)
  await db.exec(`SET ROLE app_owner;
    CREATE FUNCTION patient.guard_open_patient() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    DECLARE st text;
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.patient_id IS NOT DISTINCT FROM OLD.patient_id AND TG_ARGV[0] = 'kept_rows_mutable' THEN
        RETURN NEW;
      END IF;
      SELECT p.status INTO st FROM patient.patient p WHERE p.id = NEW.patient_id FOR KEY SHARE;
      IF st = 'merged' THEN RAISE EXCEPTION USING ERRCODE = 'P0M01', MESSAGE = 'patient.merged'; END IF;
      RETURN NEW;
    END $$;
    ALTER FUNCTION patient.guard_open_patient() OWNER TO patient_scope_owner;
    CREATE TRIGGER note_guard BEFORE INSERT OR UPDATE ON clinical.note FOR EACH ROW EXECUTE FUNCTION patient.guard_open_patient('strict');
    CREATE FUNCTION patient.guard_root() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    BEGIN
      IF OLD.status = 'merged' THEN RAISE EXCEPTION USING ERRCODE = 'P0M01', MESSAGE = 'patient.merged'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER patient_root_guard BEFORE UPDATE ON patient.patient FOR EACH ROW EXECUTE FUNCTION patient.guard_root();
    RESET ROLE;`);
  // merge b1 into a1 (as superuser standing in for complete_merge)
  await db.exec(`UPDATE patient.patient SET status='merged', merged_into='00000000-0000-0000-0000-0000000000a1' WHERE id='00000000-0000-0000-0000-0000000000b1';
                 INSERT INTO patient.staff_scope VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000f');`);
  await db.exec(`SET ROLE app_api; SELECT set_config('app.org_id','00000000-0000-0000-0000-00000000000f',false);`);
  r = await db.query(`SELECT count(*)::int c FROM clinical.note`);
  rec('MERGE-history-readable', r.rows[0].c === 2, `after merge, staff at c1 read ${r.rows[0].c} notes (a1 + merged b1)`);
  await expectError(db, 'MERGE-guard-insert', `INSERT INTO clinical.note(id, organisation_id, patient_id, body) VALUES ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000b1','x')`, 'patient.merged');
  await db.exec(`SET ROLE app_api`);
  const okIns = await db.query(`INSERT INTO clinical.note(id, organisation_id, patient_id, body) VALUES ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-00000000000f','00000000-0000-0000-0000-0000000000a1','x')`);
  rec('MERGE-guard-allows-survivor', okIns.affectedRows === 1, 'insert on survivor accepted; guard runs as patient_scope_owner (definer) and reads root under its org policy');
  await db.exec(`RESET ROLE`);
  await expectError(db, 'MERGE-root-guard', `UPDATE patient.patient SET family_name='Z' WHERE id='00000000-0000-0000-0000-0000000000b1'`, 'patient.merged');

  // ---- FOR KEY SHARE needs UPDATE privilege (SBR context): app_api has only SELECT on patient
  await db.exec(`SET ROLE app_api`);
  await expectError(db, 'LOCK-needs-update-priv', `SELECT 1 FROM patient.patient WHERE id='00000000-0000-0000-0000-0000000000a1' FOR KEY SHARE`, 'permission denied');
  await db.exec(`RESET ROLE`);

  // ---- transaction_timeout readable in a trigger (SAR-10 audit insert guard)
  await db.exec(`CREATE SCHEMA audit; CREATE TABLE audit.event (id bigint generated always as identity, at timestamptz default now());
    CREATE FUNCTION audit.require_bounded_tx() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE t text := current_setting('transaction_timeout');
    BEGIN
      IF t IS NULL OR t = '0' OR extract(epoch from t::interval) > 60 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0A01', MESSAGE = 'audit.unbounded_transaction';
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER audit_bounded BEFORE INSERT ON audit.event FOR EACH ROW EXECUTE FUNCTION audit.require_bounded_tx();`);
  await expectError(db, 'SAR10-unbounded-refused', `INSERT INTO audit.event DEFAULT VALUES`, 'audit.unbounded_transaction');
  await db.exec(`SET transaction_timeout = '60s'`);
  const a = await db.query(`INSERT INTO audit.event DEFAULT VALUES`);
  rec('SAR10-bounded-accepted', a.affectedRows === 1, `transaction_timeout=60s -> insert accepted (value read: ${(await db.query("select current_setting('transaction_timeout') t")).rows[0].t})`);
  await db.exec(`SET transaction_timeout = '120s'`);
  await expectError(db, 'SAR10-too-long-refused', `INSERT INTO audit.event DEFAULT VALUES`, 'audit.unbounded_transaction');
  await db.exec(`RESET transaction_timeout`);
  await db.exec(`ALTER ROLE app_api SET transaction_timeout = '60s'`);
  const rs = (await db.query(`SELECT setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname='app_api'`)).rows[0];
  rec('SAR10-role-level-setting', JSON.stringify(rs.setconfig).includes('transaction_timeout=60s'), `pg_db_role_setting for app_api: ${JSON.stringify(rs.setconfig)}`);

  // ---- Booking occupancy: partial exclusion constraints, stale-hold expiry for doctor AND room (SAR-09), deferred twin FK (O-3)
  await db.exec(`
    CREATE TABLE scheduling.slot_reservation (id uuid PRIMARY KEY, organisation_id uuid NOT NULL, patient_id uuid NOT NULL, service_id uuid NOT NULL);
    CREATE TABLE scheduling.slot_occupancy (
      id uuid PRIMARY KEY REFERENCES scheduling.slot_reservation(id) DEFERRABLE INITIALLY DEFERRED,
      organisation_id uuid NOT NULL, location_id uuid NOT NULL, doctor_id uuid NOT NULL, room_id uuid,
      period tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
      status text NOT NULL CHECK (status IN ('held','confirmed','cancelled','expired','checked_in','in_consultation','completed','no_show')),
      expires_at timestamptz, overbook boolean NOT NULL DEFAULT false,
      CHECK ((status = 'held') = (expires_at IS NOT NULL)),
      EXCLUDE USING gist (doctor_id WITH =, period WITH &&) WHERE (status IN ('held','confirmed','checked_in','in_consultation') AND NOT overbook),
      EXCLUDE USING gist (room_id WITH =, period WITH &&) WHERE (room_id IS NOT NULL AND status IN ('held','confirmed','checked_in','in_consultation') AND NOT overbook));
  `);
  const D = '00000000-0000-0000-0000-0000000000d1', R = '00000000-0000-0000-0000-0000000000e1', L = '00000000-0000-0000-0000-0000000000c1', O = '00000000-0000-0000-0000-00000000000f';
  const S1 = '00000000-0000-0000-0000-000000000501';
  const hold = (id, pid, doctor, room, expires) => `BEGIN;
      UPDATE scheduling.slot_occupancy SET status='expired', expires_at=NULL
        WHERE status='held' AND expires_at < now() AND period && tstzrange('2027-03-01 09:00Z','2027-03-01 09:20Z')
          AND (doctor_id = '${doctor}' OR (${room ? `room_id = '${room}'` : 'false'}));
      INSERT INTO scheduling.slot_occupancy(id, organisation_id, location_id, doctor_id, room_id, period, status, expires_at)
        VALUES ('${id}','${O}','${L}','${doctor}',${room ? `'${room}'` : 'NULL'},tstzrange('2027-03-01 09:00Z','2027-03-01 09:20Z'),'held','${expires}');
      INSERT INTO scheduling.slot_reservation(id, organisation_id, patient_id, service_id) VALUES ('${id}','${O}','${pid}','${S1}');
      COMMIT;`;
  await db.exec(hold('00000000-0000-0000-0000-000000000601', 'p-A'.padEnd(0) && '00000000-0000-0000-0000-0000000000a1', D, R, '2000-01-01Z'));
  // patient B on the same doctor: stale hold of A must be expired first, then B wins
  await db.exec(hold('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-0000000000a2', D, R, '2999-01-01Z'));
  r = await db.query(`SELECT id, status FROM scheduling.slot_occupancy ORDER BY id`);
  rec('SAR09-stale-hold-expired-then-insert', r.rows.map(x => x.status).join(',') === 'expired,held', JSON.stringify(r.rows.map(x => x.status)));
  // patient C, different doctor, same room: must be refused by the room constraint while B's live hold exists
  await expectError(db, 'SAR09-room-exclusion', hold('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000d2', R, '2999-01-01Z'), 'exclusion constraint');
  // stale hold on the room only (different doctor) is expired by the room clause
  await db.exec(`UPDATE scheduling.slot_occupancy SET expires_at='2000-01-01Z' WHERE id='00000000-0000-0000-0000-000000000602'`);
  await db.exec(hold('00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000d3', R, '2999-01-01Z'));
  r = await db.query(`SELECT status FROM scheduling.slot_occupancy WHERE id='00000000-0000-0000-0000-000000000602'`);
  rec('SAR09-room-stale-hold-expired', r.rows[0].status === 'expired', `doctor B's stale hold on the shared room -> ${r.rows[0].status}; doctor D3 hold inserted`);
  // O-3: occupancy without reservation fails at commit
  await expectError(db, 'O3-twin-deferred-fk', `BEGIN; INSERT INTO scheduling.slot_occupancy(id, organisation_id, location_id, doctor_id, period, status, expires_at)
      VALUES ('00000000-0000-0000-0000-000000000699','${O}','${L}','${D}',tstzrange('2027-03-02 09:00Z','2027-03-02 09:20Z'),'held','2999-01-01Z'); COMMIT;`, 'foreign key');
  // overbook rows are excluded from the constraint
  await db.exec(`BEGIN; INSERT INTO scheduling.slot_reservation VALUES ('00000000-0000-0000-0000-000000000605','${O}','00000000-0000-0000-0000-0000000000a5','${S1}');
    INSERT INTO scheduling.slot_occupancy(id, organisation_id, location_id, doctor_id, period, status, overbook)
    VALUES ('00000000-0000-0000-0000-000000000605','${O}','${L}','00000000-0000-0000-0000-0000000000d3',tstzrange('2027-03-01 09:00Z','2027-03-01 09:20Z'),'confirmed',true); COMMIT;`);
  rec('BR02-overbook-row-excluded', true, 'overbook row on an occupied doctor slot accepted (cap is enforced separately under a session lock)');

  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter(x => !x.ok);
  console.error(`checks=${results.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SPIKE ERROR', e); process.exit(2); });
```

## spike-out.json

```json
[
  {
    "id": "ENV",
    "ok": true,
    "detail": "PostgreSQL 18.6 (PGlite 0.5.15)"
  },
  {
    "id": "M1-owner-forced",
    "ok": true,
    "detail": "new row violates row-level security policy for table \"patient\""
  },
  {
    "id": "SBR17-owner-dml-zero-rows",
    "ok": true,
    "detail": "app_owner UPDATE under FORCE affected 0 rows"
  },
  {
    "id": "RLS-staff-scope",
    "ok": true,
    "detail": "staff at c1 sees 1 note(s)"
  },
  {
    "id": "RLS-fail-closed",
    "ok": true,
    "detail": "missing location setting -> 0 rows"
  },
  {
    "id": "RLS-withcheck",
    "ok": true,
    "detail": "new row violates row-level security policy for table \"note\""
  },
  {
    "id": "INLINE-no-search_path",
    "ok": false,
    "detail": "Seq Scan on note |   Filter: ((current_setting('app.audience'::text, true) = 'staff'::text) AND patient.staff_sees_nosp(patient_id))"
  },
  {
    "id": "INLINE-with-search_path",
    "ok": false,
    "detail": "Seq Scan on note |   Filter: ((current_setting('app.audience'::text, true) = 'staff'::text) AND patient.staff_sees(patient_id))"
  },
  {
    "id": "M4-view-definer-vs-invoker",
    "ok": true,
    "detail": "definer view (owner app_owner, FORCE) rows=0; invoker view rows=1"
  },
  {
    "id": "M4-reporting_ro-no-table",
    "ok": true,
    "detail": "permission denied for table note"
  },
  {
    "id": "MERGE-history-readable",
    "ok": true,
    "detail": "after merge, staff at c1 read 2 notes (a1 + merged b1)"
  },
  {
    "id": "MERGE-guard-insert",
    "ok": true,
    "detail": "patient.merged"
  },
  {
    "id": "MERGE-guard-allows-survivor",
    "ok": true,
    "detail": "insert on survivor accepted; guard runs as patient_scope_owner (definer) and reads root under its org policy"
  },
  {
    "id": "MERGE-root-guard",
    "ok": true,
    "detail": "patient.merged"
  },
  {
    "id": "LOCK-needs-update-priv",
    "ok": true,
    "detail": "permission denied for table patient"
  },
  {
    "id": "SAR10-unbounded-refused",
    "ok": true,
    "detail": "audit.unbounded_transaction"
  },
  {
    "id": "SAR10-bounded-accepted",
    "ok": true,
    "detail": "transaction_timeout=60s -> insert accepted (value read: 1min)"
  },
  {
    "id": "SAR10-too-long-refused",
    "ok": true,
    "detail": "audit.unbounded_transaction"
  },
  {
    "id": "SAR10-role-level-setting",
    "ok": true,
    "detail": "pg_db_role_setting for app_api: [\"transaction_timeout=60s\"]"
  },
  {
    "id": "SAR09-stale-hold-expired-then-insert",
    "ok": true,
    "detail": "[\"expired\",\"held\"]"
  },
  {
    "id": "SAR09-room-exclusion",
    "ok": true,
    "detail": "conflicting key value violates exclusion constraint \"slot_occupancy_room_id_period_excl\""
  },
  {
    "id": "SAR09-room-stale-hold-expired",
    "ok": true,
    "detail": "doctor B's stale hold on the shared room -> expired; doctor D3 hold inserted"
  },
  {
    "id": "O3-twin-deferred-fk",
    "ok": true,
    "detail": "insert or update on table \"slot_occupancy\" violates foreign key constraint \"slot_occupancy_id_fkey\""
  },
  {
    "id": "BR02-overbook-row-excluded",
    "ok": true,
    "detail": "overbook row on an occupied doctor slot accepted (cap is enforced separately under a session lock)"
  }
]
```

## inline2.js

```js
const { PGlite } = require('@electric-sql/pglite');
(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE app_api NOLOGIN; CREATE SCHEMA patient; CREATE SCHEMA clinical;
    GRANT USAGE ON SCHEMA patient, clinical TO app_api;
    CREATE TABLE patient.staff_scope (patient_id uuid NOT NULL, location_id uuid NOT NULL, PRIMARY KEY (patient_id, location_id));
    CREATE TABLE clinical.note (id uuid PRIMARY KEY, patient_id uuid NOT NULL, body text);
    CREATE INDEX ON clinical.note (patient_id);
    INSERT INTO patient.staff_scope SELECT gen_random_uuid(), ('00000000-0000-0000-0000-0000000000' || lpad((g%30)::text,2,'0'))::uuid FROM generate_series(1,60000) g;
    INSERT INTO clinical.note SELECT gen_random_uuid(), patient_id, 'x' FROM patient.staff_scope, generate_series(1,3);
    ANALYZE;
    ALTER TABLE patient.staff_scope ENABLE ROW LEVEL SECURITY; ALTER TABLE patient.staff_scope FORCE ROW LEVEL SECURITY;
    ALTER TABLE clinical.note ENABLE ROW LEVEL SECURITY; ALTER TABLE clinical.note FORCE ROW LEVEL SECURITY;
    CREATE POLICY ss ON patient.staff_scope FOR SELECT TO app_api
      USING (location_id = ANY (string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[]));
    CREATE POLICY n ON clinical.note FOR SELECT TO app_api USING (EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = note.patient_id
        AND s.location_id = ANY (string_to_array(nullif(current_setting('app.location_ids', true), ''), ',')::uuid[])));
    GRANT SELECT ON patient.staff_scope, clinical.note TO app_api;
    SET ROLE app_api; SELECT set_config('app.location_ids','00000000-0000-0000-0000-000000000001',false);`);
  const pid = (await db.query(`SELECT patient_id FROM clinical.note LIMIT 1`)).rows[0].patient_id;
  for (const q of [`SELECT id FROM clinical.note WHERE patient_id = '${pid}'`, `SELECT count(*) FROM clinical.note`]) {
    const p = await db.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${q}`);
    console.log('--', q, '\n' + p.rows.map(r => r['QUERY PLAN']).join('\n'));
  }
})();
```

## inline2-out.txt

```
-- SELECT id FROM clinical.note WHERE patient_id = 'f4d52b0e-8725-4b8b-89c2-bb3fa3c32d62' 
Index Scan using note_patient_id_idx on note (actual rows=3.00 loops=1)
  Index Cond: (patient_id = 'f4d52b0e-8725-4b8b-89c2-bb3fa3c32d62'::uuid)
  Filter: EXISTS(SubPlan 1)
  Index Searches: 1
  Buffers: shared hit=18
  SubPlan 1
    ->  Index Only Scan using staff_scope_pkey on staff_scope s (actual rows=1.00 loops=3)
          Index Cond: ((patient_id = note.patient_id) AND (location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])) AND (location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])))
          Heap Fetches: 3
          Index Searches: 3
          Buffers: shared hit=12
Planning:
  Buffers: shared hit=3
-- SELECT count(*) FROM clinical.note 
Aggregate (actual rows=1.00 loops=1)
  Buffers: shared hit=2422
  ->  Seq Scan on note (actual rows=6000.00 loops=1)
        Filter: (ANY (patient_id = (hashed SubPlan 2).col1))
        Rows Removed by Filter: 174000
        Buffers: shared hit=2422
        SubPlan 2
          ->  Bitmap Heap Scan on staff_scope s (actual rows=2000.00 loops=1)
                Recheck Cond: ((location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])) AND (location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])))
                Heap Blocks: exact=441
                Buffers: shared hit=922
                ->  Bitmap Index Scan on staff_scope_pkey (actual rows=2000.00 loops=1)
                      Index Cond: ((location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])) AND (location_id = ANY ((string_to_array(NULLIF(current_setting('app.location_ids'::text, true), ''::text), ','::text))::uuid[])))
                      Index Searches: 1
                      Buffers: shared hit=481
Planning:
  Buffers: shared hit=3
```
