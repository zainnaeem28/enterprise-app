output "account_ids" {
  value = {
    log_archive = aws_organizations_account.log_archive.id
    tooling     = aws_organizations_account.tooling.id
    staging     = aws_organizations_account.staging.id
    marketing   = aws_organizations_account.marketing.id
    production  = aws_organizations_account.production.id
  }
}

output "ou_ids" {
  value = {
    security       = aws_organizations_organizational_unit.security.id
    infrastructure = aws_organizations_organizational_unit.infrastructure.id
    prod           = aws_organizations_organizational_unit.workloads_prod.id
    nonprod        = aws_organizations_organizational_unit.workloads_nonprod.id
  }
}
