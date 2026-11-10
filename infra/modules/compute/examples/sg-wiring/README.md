# sg-wiring

Minimal root that wires `compute` and `database` together (database clients = compute service groups, compute egress target = database group).
It exists only for `tests/wiring.tftest.hcl`, a mock-provider `terraform test` that runs a **fresh plan** (no apply, no cloud access):

```sh
terraform init -backend=false && terraform test
```

Before the static-key change the plan failed with `Invalid for_each argument` on both `aws_vpc_security_group_ingress_rule.from_clients` and
`aws_vpc_security_group_egress_rule.service_database`.
