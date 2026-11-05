-- Applied as app_owner after the library has created its tables in schema queue (21.8, SBR-17).
-- Every table gets FORCE RLS and the role-targeted policy TO app_api, app_worker, queue_owner USING (true) WITH CHECK (true).
-- app_api: SELECT, INSERT, UPDATE on the tables (add_job is SECURITY INVOKER in the library and reads/upserts them), no DELETE and
-- no right on the views. app_worker: all DML on tables, SELECT on views. queue_owner is in the policy: the views run as it.
DO $harden$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE queue.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE queue.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS queue_roles ON queue.%I', t.relname);
    EXECUTE format('CREATE POLICY queue_roles ON queue.%I FOR ALL TO app_api, app_worker, queue_owner USING (true) WITH CHECK (true)', t.relname);
    EXECUTE format('REVOKE ALL ON queue.%I FROM PUBLIC, app_api, app_worker', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON queue.%I TO app_worker', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON queue.%I TO app_api', t.relname);
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('v', 'm') LOOP
    EXECUTE format('REVOKE ALL ON queue.%I FROM PUBLIC, app_api, app_worker', t.relname);
    EXECUTE format('GRANT SELECT ON queue.%I TO app_worker', t.relname);
  END LOOP;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA queue TO app_api, app_worker;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA queue TO app_api, app_worker;
  -- Ownership moves to queue_owner last (SET membership, db/roles); FORCE above applies to the new owner as well.
  GRANT CREATE ON SCHEMA queue TO queue_owner;
  FOR t IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i') AND d.classid = 'pg_class'::regclass) LOOP
    EXECUTE format('ALTER %s queue.%I OWNER TO queue_owner',
      CASE t.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, t.relname);
  END LOOP;
  FOR t IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'queue' LOOP
    EXECUTE format('ALTER %s %s OWNER TO queue_owner', CASE t.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, t.sig);
  END LOOP;
  FOR t IN SELECT ty.typname FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
           WHERE n.nspname = 'queue' AND ty.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE queue.%I OWNER TO queue_owner', t.typname);
  END LOOP;
  ALTER SCHEMA queue OWNER TO queue_owner;
END
$harden$;
