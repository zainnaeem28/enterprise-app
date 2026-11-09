-- migration-class: expand
-- INT03-F05 ruling (HEAAA-311), C-F05-1: validate the constraint added NOT VALID in 2102. Own file, own transaction:
-- VALIDATE takes SHARE UPDATE EXCLUSIVE.
ALTER TABLE reporting.ops_alert_backlog VALIDATE CONSTRAINT ops_alert_backlog_alert_type_format;
