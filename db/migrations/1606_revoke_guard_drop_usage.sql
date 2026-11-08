-- migration-class: expand
-- INT02-F02 (HEAAA-186): 1604 granted patient_scope_owner USAGE on documents and telehealth only so that 1605 could drop the
-- copies of the merge guard it owns. The role keeps no right on those schemas (least privilege, 21.2).
REVOKE USAGE ON SCHEMA documents, telehealth FROM patient_scope_owner;
