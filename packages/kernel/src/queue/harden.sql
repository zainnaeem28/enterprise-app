-- Applied as queue_owner after the library has created its tables in schema queue (21.8, SBR-17).
-- Every table gets FORCE RLS and the role-targeted policy TO app_api, app_worker USING (true) WITH CHECK (true).
-- app_api: INSERT only (through add_job, which is SECURITY INVOKER in the library; see install test). app_worker: all DML.
DO $harden$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE queue.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE queue.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS queue_roles ON queue.%I', t.relname);
    EXECUTE format('CREATE POLICY queue_roles ON queue.%I FOR ALL TO app_api, app_worker USING (true) WITH CHECK (true)', t.relname);
    EXECUTE format('REVOKE ALL ON queue.%I FROM PUBLIC, app_api, app_worker', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON queue.%I TO app_worker', t.relname);
    EXECUTE format('GRANT INSERT ON queue.%I TO app_api', t.relname);
  END LOOP;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA queue TO app_api, app_worker;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA queue TO app_api, app_worker;
END
$harden$;
