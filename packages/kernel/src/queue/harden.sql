-- Applied as app_owner (first install) or queue_owner (every later run) after the library has created its tables in
-- schema queue (21.8, SBR-17; amendment A-1, HEAAA-152). Re-run it after every library upgrade.
-- Tables in queue: FORCE RLS and the role-targeted policy TO app_worker, queue_owner USING (true) WITH CHECK (true).
-- app_api has NO right in schema queue. It enqueues only through queue_api.enqueue (SECURITY DEFINER, owner queue_owner).
-- app_worker: all DML on tables, SELECT on views, EXECUTE on the library functions. queue_owner is in the policy: it is
-- subject to FORCE and the library DML runs as it inside queue_api.enqueue.
DO $harden$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE queue.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE queue.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS queue_roles ON queue.%I', t.relname);
    EXECUTE format('CREATE POLICY queue_roles ON queue.%I FOR ALL TO app_worker, queue_owner USING (true) WITH CHECK (true)', t.relname);
    EXECUTE format('REVOKE ALL ON queue.%I FROM PUBLIC, app_api, app_worker', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON queue.%I TO app_worker', t.relname);
  END LOOP;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'queue' AND c.relkind IN ('v', 'm') LOOP
    EXECUTE format('REVOKE ALL ON queue.%I FROM PUBLIC, app_api, app_worker', t.relname);
    EXECUTE format('GRANT SELECT ON queue.%I TO app_worker', t.relname);
  END LOOP;
  REVOKE ALL ON SCHEMA queue FROM PUBLIC, app_api;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA queue FROM PUBLIC, app_api;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA queue FROM PUBLIC, app_api;
  GRANT USAGE ON SCHEMA queue TO app_worker;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA queue FROM app_worker;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA queue TO app_worker;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA queue TO app_worker;
  -- Runs as the installing role (app_owner first, queue_owner after the handover): app_owner cannot set defaults FOR queue_owner.
  ALTER DEFAULT PRIVILEGES IN SCHEMA queue REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  -- queue_api: the API tier's only queue surface (A-1). Created by app_owner on first install; owner moves below.
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'queue_api') THEN
    CREATE SCHEMA queue_api;
  END IF;
  REVOKE ALL ON SCHEMA queue_api FROM PUBLIC;
  GRANT USAGE ON SCHEMA queue_api TO app_api, app_worker, identity_bootstrap_owner;
  ALTER DEFAULT PRIVILEGES IN SCHEMA queue_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS queue_api.task_type (
    task_identifier text PRIMARY KEY CHECK (task_identifier ~ '^[a-z][a-z0-9_]{0,40}\.[a-z][a-z0-9_]{0,60}$'),
    job_class text NOT NULL CHECK (job_class IN ('handler', 'job', 'system', 'data_repair')),
    api_enqueue boolean NOT NULL DEFAULT false CHECK (NOT api_enqueue OR job_class IN ('handler', 'job')),
    max_attempts smallint NOT NULL CHECK (max_attempts BETWEEN 1 AND 25),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE queue_api.task_type ENABLE ROW LEVEL SECURITY;
  ALTER TABLE queue_api.task_type FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS task_type_owner_read ON queue_api.task_type;
  DROP POLICY IF EXISTS task_type_worker ON queue_api.task_type;
  CREATE POLICY task_type_owner_read ON queue_api.task_type FOR SELECT TO queue_owner USING (true);
  CREATE POLICY task_type_worker ON queue_api.task_type FOR ALL TO app_worker USING (true) WITH CHECK (true);
  REVOKE ALL ON queue_api.task_type FROM PUBLIC, app_api, app_worker;
  GRANT SELECT, INSERT, UPDATE ON queue_api.task_type TO app_worker;
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
  GRANT CREATE ON SCHEMA queue_api TO queue_owner;
  ALTER TABLE queue_api.task_type OWNER TO queue_owner;
END
$harden$;

-- The wrapper. Replaced on every run so the body always matches this file. plpgsql, fixed search_path, every object
-- schema-qualified. Runs in the caller's transaction.
CREATE OR REPLACE FUNCTION queue_api.enqueue(
  p_task_identifier text, p_payload jsonb, p_run_at timestamptz DEFAULT NULL,
  p_job_key text DEFAULT NULL, p_priority smallint DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $enqueue$
DECLARE
  v_max smallint;
  v_id bigint;
BEGIN
  IF p_task_identifier IS NULL OR p_task_identifier !~ '^[a-z][a-z0-9_]{0,40}[.][a-z][a-z0-9_]{0,60}$' THEN
    RAISE EXCEPTION 'queue_api.enqueue: bad task identifier' USING ERRCODE = '22023';
  END IF;
  SELECT t.max_attempts INTO v_max FROM queue_api.task_type t
   WHERE t.task_identifier = p_task_identifier AND t.api_enqueue;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue_api.enqueue: task type not allowed' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR pg_catalog.octet_length(p_payload::text) > 4096 THEN
    RAISE EXCEPTION 'queue_api.enqueue: payload must be a JSON object of at most 4096 bytes' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_path_exists(p_payload, '$.**{5 to last}') THEN
    RAISE EXCEPTION 'queue_api.enqueue: payload too deep' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_path_exists(p_payload,
       '$.** ? (@.type() == "string" && !(@ like_regex "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" || @ like_regex "^[a-z][a-z0-9_]{0,40}$"))') THEN
    RAISE EXCEPTION 'queue_api.enqueue: payload holds a value that is not an ID or scope key' USING ERRCODE = '22023';
  END IF;
  IF p_run_at IS NOT NULL AND (p_run_at < pg_catalog.now() - interval '5 minutes'
                               OR p_run_at > pg_catalog.now() + interval '400 days') THEN
    RAISE EXCEPTION 'queue_api.enqueue: run_at out of range' USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NULL OR p_priority < 0 OR p_priority > 10 THEN
    RAISE EXCEPTION 'queue_api.enqueue: priority out of range' USING ERRCODE = '22023';
  END IF;
  IF p_job_key IS NOT NULL AND p_job_key !~ '^[A-Za-z0-9_:.-]{1,100}$' THEN
    RAISE EXCEPTION 'queue_api.enqueue: bad job key' USING ERRCODE = '22023';
  END IF;
  SELECT j.id INTO v_id FROM queue.add_job(
    identifier => p_task_identifier, payload => p_payload::json, run_at => p_run_at,
    max_attempts => v_max::int,
    job_key => CASE WHEN p_job_key IS NULL THEN NULL ELSE p_task_identifier || ':' || p_job_key END,
    priority => p_priority::int, job_key_mode => 'replace') AS j;
  RETURN v_id;
END
$enqueue$;
ALTER FUNCTION queue_api.enqueue(text, jsonb, timestamptz, text, smallint) OWNER TO queue_owner;
REVOKE ALL ON FUNCTION queue_api.enqueue(text, jsonb, timestamptz, text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_api.enqueue(text, jsonb, timestamptz, text, smallint) TO app_api, app_worker, identity_bootstrap_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA queue_api FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_api.enqueue(text, jsonb, timestamptz, text, smallint) TO app_api, app_worker, identity_bootstrap_owner;
ALTER SCHEMA queue_api OWNER TO queue_owner;
