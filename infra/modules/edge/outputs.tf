output "distribution_domain_names" {
  description = "Targets for the portal DNS records (managed outside this module)."
  value       = { for k, d in aws_cloudfront_distribution.portal : k => d.domain_name }
}

output "distribution_ids" {
  description = "For the release step's invalidation of the entry document and release.json."
  value       = { for k, d in aws_cloudfront_distribution.portal : k => d.id }
}

output "distribution_arns" {
  value = { for k, d in aws_cloudfront_distribution.portal : k => d.arn }
}

output "portal_bucket_names" {
  value = { for k, b in aws_s3_bucket.portal : k => b.id }
}

output "portal_bucket_arns" {
  value = { for k, b in aws_s3_bucket.portal : k => b.arn }
}

output "regional_web_acl_arn" {
  value = aws_wafv2_web_acl.regional.arn
}

output "cloudfront_web_acl_arn" {
  value = aws_wafv2_web_acl.cloudfront.arn
}
