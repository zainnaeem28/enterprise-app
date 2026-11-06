# Agreed directory views and public policies (INT01-F2)

Single list used by `apps/api/src/modules/organisation/organisation.dbtest.ts` and `db/tools/catalog-lists.mjs` (`ownerRightsViews`, `publicPolicies`).

## Views owned by `directory_ro` (owner-rights, C0)
organisation: public_location, public_service, public_service_location, public_service_clinician, public_opening_hours, public_holiday, public_banner (BE-03).
identity: public_clinician (BE-04, migration 0503; columns principal_id, display_name, organisation_id; listed active google-realm clinicians only; no npi/dea/email).

## Policies that can match audience `public`
- organisation `<table>_directory` on location, service, service_location, service_clinician, opening_hours, holiday, banner (BE-03).
- identity.principal.principal_directory, identity.staff_profile.staff_profile_directory (BE-04): TO directory_ro only, org-scoped, audience IN (public, patient), column grants limited to the 22.5.1 columns.
- kernel.rate_counter.rate_counter_org (recorded exception F03-N1).

## Status
Security Reviewer confirmation that identity.public_clinician and the two identity public policies are intended exposure: PENDING (independent review required; not self-confirmed).
