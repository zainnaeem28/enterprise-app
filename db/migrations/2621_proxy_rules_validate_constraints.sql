-- migration-class: expand
-- HEAAA-791: validates the CHECK constraints 2620 added NOT VALID (DEVOPS-PLAN 5.2: the two steps are separate migrations). Every
-- existing row already satisfies them: the new columns carry constant defaults, no existing row has a missing proxy or an invitation.
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_scopes_ck;
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_source_ck;
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_ended_by_ck;
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_invite_email_ck;
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_pending_invite_ck;
ALTER TABLE identity.proxy_grant VALIDATE CONSTRAINT proxy_grant_guardian_dates_ck;
