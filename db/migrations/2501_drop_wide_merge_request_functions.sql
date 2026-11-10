-- migration-class: contract
-- contract-approval: HEAAA-650 Architect ruling (rejected waiver of SEC03-F10 (b)), ARCHITECTURE 21.6 DF-10 / amendment A-2.4
-- HEAAA-657 (QS-03 F10b). Drops the two definer functions that return the whole patient.merge_request row type (both patient IDs, the
-- free-text reason, the requester and approver person and principal IDs) to a caller who may not see those patients. 2502 creates
-- them again under the same names with a fixed, narrowed column list. The return type cannot change in place (CREATE OR REPLACE
-- refuses it), so this is a drop and a create; no application code calls either function between the two files (one deploy).
-- Owner step (21.2 point 5), DROP FUNCTION WITHOUT CASCADE: a dependency error here is a failure, never a reason to add CASCADE.

SET LOCAL ROLE patient_scope_owner;
DROP FUNCTION patient.get_merge_request(uuid);
DROP FUNCTION patient.decide_merge(uuid, uuid, text);
RESET ROLE;
