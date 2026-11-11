-- migration-class: contract
-- contract-approval: HEAAA-789 decision log D1 (owner ruling 2026-11-11 C item 1, HEAAA-33 comment): D-8 is decided, so a deletion request is no longer
-- limited to blocked_d8 or refused. This only RELAXES a rule. The previous release keeps working against it: it still writes blocked_d8 for a deletion
-- request, which 2600 still accepts. The new code needs this constraint gone, so unlike a normal contraction this file ships WITH the release that
-- contains the deletion flow, not after it (release note: apply 2600-2602 together).
--
-- Down-note (forward-only): to go back, ADD CONSTRAINT request_deletion_blocked CHECK (kind <> 'deletion' OR status IN ('blocked_d8', 'refused'))
-- NOT VALID, after no deletion request is in any other state.

ALTER TABLE privacy.request DROP CONSTRAINT request_deletion_blocked;
