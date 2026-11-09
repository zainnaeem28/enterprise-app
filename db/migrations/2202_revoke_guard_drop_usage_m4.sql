-- migration-class: expand
-- INT03-F03 (HEAAA-312): 2200 granted patient_scope_owner USAGE on clinical and privacy only so that 2201 could drop the
-- copies of the merge guard it owns. The role keeps no right on those schemas (least privilege, 21.2).
REVOKE USAGE ON SCHEMA clinical, privacy FROM patient_scope_owner;
