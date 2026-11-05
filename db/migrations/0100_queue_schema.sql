-- migration-class: expand
-- Queue schema for the queue library (ARCHITECTURE 21.8, ADR-020). Graphile Worker installs its own tables into this
-- schema through packages/kernel/src/queue/install.ts (library migrations, run as queue_owner); the FORCE policies and
-- grants are then applied by packages/kernel/src/queue/harden.sql. This file creates only the schema.
-- UNEXECUTED: written without a PostgreSQL 17 server. Needs app_owner to be a member of queue_owner with SET TRUE
-- (db/roles is F-03's: request to the Orchestrator).

CREATE SCHEMA queue AUTHORIZATION queue_owner;
COMMENT ON SCHEMA queue IS 'Queue library tables: the outbox (ARCHITECTURE 21.8). IDs only (BD-09), class C1';
REVOKE ALL ON SCHEMA queue FROM PUBLIC;
GRANT USAGE ON SCHEMA queue TO app_api, app_worker;
