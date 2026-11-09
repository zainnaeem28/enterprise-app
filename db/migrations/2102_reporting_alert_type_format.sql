-- migration-class: expand
-- INT03-F05 ruling (HEAAA-311), condition C-F05-1 for amendment F05-1 (ARCHITECTURE 22.15, ops_alert_backlog):
-- alert_type holds a code token copied from notifications.staff_alert.type, never text. The format is checked here, not
-- the value list, so a new staff_alert type does not break the refresh; the source CHECK keeps the value list.
-- Added NOT VALID here and validated in 2103 (DEVOPS-PLAN 5.2).
ALTER TABLE reporting.ops_alert_backlog
  ADD CONSTRAINT ops_alert_backlog_alert_type_format CHECK (alert_type ~ '^[a-z][a-z0-9_]{0,40}$') NOT VALID;
