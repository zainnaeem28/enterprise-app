# Account roots (authored only, nothing applied)

One OpenTofu root per AWS account, one state object per root
(`accounts/<name>/terraform.tfstate`) in the versioned, KMS-encrypted,
cross-Region-replicated bucket created by `../bootstrap` in the `tooling` account.

| Root | Account | Contents in this ticket |
| --- | --- | --- |
| `management` | Organizations management | OUs, member accounts, three SCPs (guardrails, region restriction, control plane) |
| `tooling` | tooling | none yet (state backend is `../bootstrap`) |
| `log-archive` | log-archive | KMS key and bucket for VPC flow logs |
| `staging` | staging | 2-AZ network, data and secrets KMS keys |
| `production` | production | 3-AZ network (NAT per AZ), keys, recovery-Region VPC and replica key |
| `marketing` | marketing | 2-AZ network, keys (no path to production data) |

Not in this ticket: ECS, RDS, ALB, CloudFront, WAF, Cognito, CloudTrail/GuardDuty/Config,
OIDC providers and `gh-*` roles, and the `infra/approvals` root. They belong to later tickets and paths.

## Assumptions stated pending human decisions

- **C-12 (us-east-1 exemptions).** The exemption list in `management/main.tf` is the list in
  DEVOPS-PLAN 3.1 and is **unverified** for the Chime SDK control plane and Cognito custom
  domains. Region availability and BAA eligibility were not checked (DEVOPS-PLAN 3.3 assigns
  that to the foundation task on the build date). `attach_scps` therefore defaults to `false`:
  the region-restriction SCP is created but not attached until the list is verified.
- **C-21 (SCP owner).** The only principal exempt from the control-plane SCP is the
  `platform-admin-apply` Identity Center role (pattern in `platform_admin_role_arn_pattern`).
  Named people are not assumed. The SCP content, attachment and any change are human actions.
- **Retention.** Flow-log retention (400 days) is a placeholder, not an approved value.
- **CIDRs** (`10.10/16` production, `10.11/16` recovery, `10.20/16` staging, `10.30/16` marketing)
  are proposals; loadtest and restore-test VPCs need their own ranges later.
- **SCP size.** SCPs are limited to 5,120 characters; the rendered size has not been checked
  against the live service (only authored and validated).
- Account e-mail addresses, `apply_role_arn` values, the organisation ID and bucket names are inputs; no values are committed.

## Using it (humans, later, after G3-equivalent approval for the target account)

1. `../bootstrap`: apply once with local state in `tooling`, then migrate state into the bucket.
2. `tofu init -backend-config=backend.hcl` in each root, where `backend.hcl` holds the `backend_config_hint` output. Never commit it with credentials (it has none).
3. Review `tofu plan` output before any apply. The pipelines never apply the management root.

## Local checks

`tofu fmt -check -recursive infra`, `tofu init -backend=false && tofu validate` in each root,
`tflint (config `.tflint.hcl` in each directory)`, and `tofu test` in `modules/kms` and `modules/network` (mock provider).
