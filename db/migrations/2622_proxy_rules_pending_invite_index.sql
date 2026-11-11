-- migration-class: expand
-- transaction: none
-- HEAAA-791: one pending invitation per patient and address (a second invite to the same address is refused, not stacked).
CREATE UNIQUE INDEX CONCURRENTLY proxy_grant_pending_invite_uq ON identity.proxy_grant (patient_id, invited_email) WHERE proxy_principal_id IS NULL AND status IN ('requested', 'verified');
