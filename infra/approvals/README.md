# Approvals root (structure only, DO-04)

Owns the GitHub OIDC providers, every `gh-*` role, the permission boundary and the
`/approved/*` records (DEVOPS-PLAN 4.1 A2, 7.4, 7.5). Authored and plan-tested; **nothing is
applied** and every record is empty, so every role is denied.

- **Who applies:** only a human with the `platform-admin-apply` Identity Center role. The agent
  identity has no AWS identity. Its state has its own bucket and KMS key (`backend.hcl`, not committed).
- **How a role is enabled:** a pull request adds a record to `*_records` (see `modules/ci-trust`
  for the schema and limits). Needs CODEOWNERS approval by a human who is not the author, then a human apply.
  `audit-archive` and `bootstrap-<env>` need two distinct approvers and expire within 24 h.
  Remove the record and apply to revoke.
- **Enforcement limit (C-13):** without GitHub rulesets / required review on this repository's plan,
  the CODEOWNERS and "not the author" rules are **procedural only**. The AWS-side deny by default is
  the control that holds. See `docs/` evidence for DO-04.
- **Not in this root:** `infra/approvals-staging` (separate state in the staging account; needs a path
  assignment, requested from the Orchestrator) and the SCPs (management root, DO-01).
