-- migration-class: expand
-- Queue schema for the queue library (ARCHITECTURE 21.8, ADR-020). Graphile Worker installs its own tables into this
-- schema through packages/kernel/src/queue/install.ts (library migrations, run as queue_owner); the FORCE policies and
-- grants are then applied by packages/kernel/src/queue/harden.sql. This file creates only the schema.
-- Created as app_owner: the library's own `create schema if not exists` needs CREATE on the database, which queue_owner
-- must not hold. Ownership of the schema and every library object moves to queue_owner at the end of
-- packages/kernel/src/queue/harden.sql (install runs once per deployment, as app_owner).

CREATE SCHEMA queue;
COMMENT ON SCHEMA queue IS 'Queue library tables: the outbox (ARCHITECTURE 21.8). IDs only (BD-09), class C1';
REVOKE ALL ON SCHEMA queue FROM PUBLIC;
GRANT USAGE ON SCHEMA queue TO app_worker; -- app_api has no right in schema queue (21.8, amendment A-1)
