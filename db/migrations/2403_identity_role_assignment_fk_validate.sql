-- migration-class: expand
-- Validates the foreign key that 2400 added NOT VALID (DEVOPS-PLAN 5.2: the two steps are separate migrations). No row can
-- violate it: role_assignment is empty until the first approved request is applied.
ALTER TABLE identity.role_assignment VALIDATE CONSTRAINT role_assignment_granted_via_request_fk;
