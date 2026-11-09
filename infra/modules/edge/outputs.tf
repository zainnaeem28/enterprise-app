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

output "integrations_web_acl_arn" {
  value = aws_wafv2_web_acl.integrations.arn
}

output "integrations_distribution_id" {
  description = "For the integrations alias record when route53_zone_id is null, and for monitoring."
  value       = aws_cloudfront_distribution.integrations.id
}

output "integrations_distribution_domain_name" {
  description = "Target for the integrations. DNS alias when route53_zone_id is null."
  value       = aws_cloudfront_distribution.integrations.domain_name
}

output "integrations_distribution_hosted_zone_id" {
  value = aws_cloudfront_distribution.integrations.hosted_zone_id
}

output "vpc_origin_id" {
  value = aws_cloudfront_vpc_origin.alb.id
}

output "cloudfront_web_acl_arn" {
  value = aws_wafv2_web_acl.cloudfront.arn
}
