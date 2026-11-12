# admin-compliance (FE-13, HEAAA-132)

Administrator-realm screens: **AD-01 audit log** (filters, export with job state and ready notice), **AD-02 break-the-glass review**,
**AD-03 users & roles** (role-change request and the approval screen, different-approver messages), **AD-05 privacy requests**.
Design: UI-UX 3.1, 3.2, 4, 6; mockup desktop 6; PRD RA-R1-11, RA-R1-12, RA-R1-14, RA-R1-32. Built on FE-17 (`../admin-auth`: `ElevationProvider`, `callPrivileged`).

- Entry: `AdminCompliancePortal({ runtime, path, navigate })`, paths `/admin/audit`, `/admin/btg`, `/admin/users`, `/admin/privacy`. It must be
  rendered inside FE-17's `ElevationProvider` under `AdminRealmBar`.
- The server authorizes every call. The UI says "a different administrator must approve" before the click and translates `identity.self_approval`,
  `identity.approver_is_subject`, `identity.request_expired`, `audit.self_review`, `audit.invalid_transition`, `audit.export_too_large`.
- Calls go through the untyped seam (`api.ts`), because the generated response types of these operations are `OpaqueObject`; bodies are those of the
  BE-24 audit routes, BE-05 identity admin controller and BE-20 privacy controller. `types.ts` validates every response before use.

## Not done here (needs the Orchestrator)

1. **Wiring (done).** `StaffApp.tsx` renders `AdminCompliancePortal` for `isAdminCompliancePath(path)` in the admin realm.
2. **Contract gap, approval screen.** There is no `GET /admin/role-change-requests[/{id}]` route (the controller mounts only POST create/approve/reject/cancel; the service has a read method, `identity/admin/service.ts`, that no route exposes), so an approver
   cannot be shown a request's details before deciding. The screen approves or rejects by request reference and lists the requests made in this window (cancel, and a block on
   approving one's own). A list/read route needs a BE-05/BE-24 correction ticket; the screen can then show details with no other change.
3. **No export list route** (`GET /admin/audit-exports`): job state is followed for the export requested in this window only.
4. **Mocks.** Unit and browser tests run against contract mocks. The real API/database journey and the physical security key are not exercised here.
