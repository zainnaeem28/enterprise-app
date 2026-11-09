output "role_state" {
  description = "Which gh-* roles a record currently enables. All false until a human applies a record."
  value = merge(
    { for n, s in module.ci_trust_production.role_state : "production/${n}" => s },
    { for n, s in module.ci_trust_tooling.role_state : "tooling/${n}" => s },
    { for n, s in module.ci_trust_marketing.role_state : "marketing/${n}" => s },
  )
}

output "trust_policies" {
  value = {
    production = module.ci_trust_production.trust_policies
    tooling    = module.ci_trust_tooling.trust_policies
    marketing  = module.ci_trust_marketing.trust_policies
  }
}
