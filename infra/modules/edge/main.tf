data "aws_caller_identity" "current" {}

locals {
  tags = merge(var.tags, { Module = "edge" })

  # AWS managed policy Managed-CachingDisabled; its ID is fixed and documented by AWS.
  caching_disabled_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

  s3_origin_id  = "portal-bucket"
  alb_origin_id = "api-alb"

  # Every host reaches the one internal ALB through CloudFront and the VPC origin below
  # (ARCHITECTURE 8.1 TB1, ADR-005). Nothing reaches the ALB from the internet.
  integrations_origin_id = "api-alb"

  integrations_host_match = {
    search_string = lower(var.integrations_host)
  }

  bot_control_regex = "^(${join("|", var.bot_control_paths)})"
}

# ---------------------------------------------------------------------------
# Portal buckets (public static bundles; no PHI, so SSE-S3 keeps the OAC policy simple)
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "portal" {
  # checkov:skip=CKV_AWS_144:Static public bundles are rebuilt from the tagged release in CI; no PHI and no recovery-Region copy is needed.
  # checkov:skip=CKV_AWS_145:Public static bundles (no PHI); SSE-S3 keeps the CloudFront OAC policy free of KMS key-policy coupling.
  # checkov:skip=CKV_AWS_18:Reads are logged by CloudFront standard logging; S3 access logging adds a second log bucket for no extra signal.
  # checkov:skip=CKV2_AWS_62:No event consumers; bundles are uploaded by the release pipeline.
  for_each = var.portals
  bucket   = "${var.name}-portal-${each.key}-${data.aws_caller_identity.current.account_id}"
  tags     = local.tags
}

resource "aws_s3_bucket_public_access_block" "portal" {
  for_each                = var.portals
  bucket                  = aws_s3_bucket.portal[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "portal" {
  for_each = var.portals
  bucket   = aws_s3_bucket.portal[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "portal" {
  for_each = var.portals
  bucket   = aws_s3_bucket.portal[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "portal" {
  for_each = var.portals
  bucket   = aws_s3_bucket.portal[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "portal" {
  for_each = var.portals
  bucket   = aws_s3_bucket.portal[each.key].id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.portal]
}

data "aws_iam_policy_document" "portal_bucket" {
  for_each = var.portals

  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.portal[each.key].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.portal[each.key].arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.portal[each.key].arn, "${aws_s3_bucket.portal[each.key].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "portal" {
  for_each = var.portals
  bucket   = aws_s3_bucket.portal[each.key].id
  policy   = data.aws_iam_policy_document.portal_bucket[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.portal]
}

# ---------------------------------------------------------------------------
# CloudFront building blocks
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "portal" {
  name                              = "${var.name}-portal"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Client-side routing without custom error responses: error responses apply to every behaviour,
# so a 403/404 from /api/* would be rewritten to index.html. The function touches only the default
# behaviour and leaves /api/*, release.json and assets/* alone.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  comment = "Rewrite extension-less paths to /index.html"
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.indexOf('.') === -1 || uri === '/') {
        request.uri = '/index.html';
      }
      return request;
    }
  JS
}

# Entry document: short TTL, no cookies, no query strings, no headers in the cache key.
resource "aws_cloudfront_cache_policy" "entry" {
  name        = "${var.name}-entry"
  min_ttl     = 0
  default_ttl = var.entry_ttl_seconds
  max_ttl     = var.entry_ttl_seconds

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# release.json: polled by the portal; no cookie, never cached long.
resource "aws_cloudfront_cache_policy" "release" {
  name        = "${var.name}-release-json"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 10

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# Content-hashed assets under assets/ are immutable.
resource "aws_cloudfront_cache_policy" "assets" {
  name        = "${var.name}-assets"
  min_ttl     = 31536000
  default_ttl = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# /api/*: every cookie, every viewer header (Authorization, Host, X-Client-Release, Last-Event-ID)
# and every query string reach the ALB. Host is needed because the API derives the audience from it.
resource "aws_cloudfront_origin_request_policy" "api" {
  name = "${var.name}-api-all-viewer"

  cookies_config {
    cookie_behavior = "all"
  }
  headers_config {
    header_behavior = "allViewer"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

# integrations.: every viewer header (Host, Authorization, vendor signature and timestamp headers,
# the X-Goog-* headers of ARCHITECTURE 29.5) and every query string reach the ALB; no cookie does.
# The host accepts none, and the web ACL also refuses any request that carries one.
resource "aws_cloudfront_origin_request_policy" "integrations" {
  name = "${var.name}-integrations-all-viewer-no-cookies"

  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "allViewer"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

# One VPC origin for the internal ALB, shared by the portal and integrations distributions.
# CloudFront creates the AWS-managed CloudFront-VPCOrigins-Service-SG in the VPC when the first VPC
# origin exists; the ALB admits only that group.
resource "aws_cloudfront_vpc_origin" "alb" {
  tags = local.tags

  vpc_origin_endpoint_config {
    name                   = "${var.name}-alb"
    arn                    = var.alb_arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "https-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

data "aws_security_group" "vpc_origin_service" {
  name   = "CloudFront-VPCOrigins-Service-SG"
  vpc_id = var.vpc_id

  depends_on = [aws_cloudfront_vpc_origin.alb]
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpc_origin" {
  security_group_id            = var.alb_security_group_id
  description                  = "HTTPS from the CloudFront VPC origin service group"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = data.aws_security_group.vpc_origin_service.id
}

resource "aws_cloudfront_response_headers_policy" "portal" {
  # checkov:skip=CKV_AWS_259:HSTS max-age 2 years with includeSubDomains is set; the preload flag is deliberately off because browser preload lists are hard to undo. Owner decision.
  name = "${var.name}-portal-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    content_security_policy {
      content_security_policy = var.content_security_policy
      override                = true
    }
  }
}

# integrations.: API responses. Security headers only where the origin sets none (override = false);
# no Cache-Control or CSP is touched, the API controls its own caching.
resource "aws_cloudfront_response_headers_policy" "integrations" {
  # checkov:skip=CKV_AWS_259:HSTS max-age 2 years with includeSubDomains is set; the preload flag is deliberately off because browser preload lists are hard to undo. Owner decision.
  name = "${var.name}-integrations-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = false
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = false
    }
  }
}

# ---------------------------------------------------------------------------
# One distribution per portal host
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "portal" {
  # checkov:skip=CKV_AWS_310:No secondary origin exists; the API has one ALB and the bundles one bucket. Regional failure is handled by the region-loss runbook.
  # checkov:skip=CKV_AWS_374:Patients and staff may be abroad; geo blocking is a product/security decision not made here.
  # checkov:skip=CKV2_AWS_47:The check also demands AWSManagedRulesAnonymousIpList, which would block patients on VPNs; KnownBadInputs (Log4j) is present. Needs a Security decision.
  for_each = var.portals

  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${var.name} ${each.key} portal"
  aliases             = [each.value.host]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.cloudfront.arn
  tags                = local.tags

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.portal[each.key].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.portal.id
  }

  # The ALB is internal and is reached through the VPC origin. CloudFront sends the viewer Host to
  # it (origin request policy), so the ALB certificate must cover the portal hosts and the
  # integrations host. HTTPS only, TLS 1.2+. The origin-verify header stays as defence in depth.
  origin {
    origin_id   = local.alb_origin_id
    domain_name = var.alb_dns_name

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.alb.id
      origin_read_timeout      = var.origin_read_timeout_seconds
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = var.origin_verify_header_name
      value = var.origin_verify_secret
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.entry.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.portal.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  # Never cached, all cookies and Authorization forwarded. No function, no response policy
  # that could touch Cache-Control; the API sends no-store itself.
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.alb_origin_id
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api.id
  }

  # Served from S3 only; the cache and origin request policies carry no cookies, so none reach S3
  # and the path can never be routed to the API.
  ordered_cache_behavior {
    path_pattern               = "/release.json"
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.release.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.portal.id
  }

  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.portal.id
  }

  logging_config {
    bucket          = var.cloudfront_logs_bucket_domain
    prefix          = "cloudfront/${each.key}/"
    include_cookies = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.cloudfront_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---------------------------------------------------------------------------
# integrations. distribution (machine clients: partners, vendor webhooks, public read API)
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "integrations" {
  # checkov:skip=CKV_AWS_310:No secondary origin exists; the API has one ALB. Regional failure is handled by the region-loss runbook.
  # checkov:skip=CKV_AWS_374:Partner and vendor systems may call from outside the US; geo blocking is a product/security decision not made here.
  # checkov:skip=CKV_AWS_305:API host (HEAAA-573 D-F37-2): a default root object would rewrite "/" to /index.html at the origin; the API serves no static document.
  # checkov:skip=CKV2_AWS_47:The check also demands AWSManagedRulesAnonymousIpList; vendor webhooks (for example Google) come from hosting ranges that list may cover. KnownBadInputs (Log4j) is present. Needs a Security decision.
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "${var.name} integrations"
  aliases         = [var.integrations_host]
  price_class     = "PriceClass_100"
  web_acl_id      = aws_wafv2_web_acl.integrations.arn
  tags            = local.tags

  origin {
    origin_id   = local.integrations_origin_id
    domain_name = var.alb_dns_name

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.alb.id
      origin_read_timeout      = var.origin_read_timeout_seconds
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = var.origin_verify_header_name
      value = var.origin_verify_secret
    }
  }

  # Single behaviour: nothing is cached, no cookie is forwarded, the request body and method pass.
  default_cache_behavior {
    target_origin_id           = local.integrations_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = local.caching_disabled_policy_id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.integrations.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.integrations.id
  }

  logging_config {
    bucket          = var.cloudfront_logs_bucket_domain
    prefix          = "cloudfront/integrations/"
    include_cookies = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.integrations_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Portal DNS is managed outside this module; the integrations alias is created here when a zone is given.
resource "aws_route53_record" "integrations" {
  for_each = var.route53_zone_id == null ? toset([]) : toset(["A", "AAAA"])

  zone_id = var.route53_zone_id
  name    = var.integrations_host
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.integrations.domain_name
    zone_id                = aws_cloudfront_distribution.integrations.hosted_zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# WAF: CloudFront scope (portals)
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "cloudfront" {
  provider    = aws.us_east_1
  name        = "${var.name}-portals"
  description = "Portal distributions: managed rules, per-IP and per-path rate limits"
  scope       = "CLOUDFRONT"
  tags        = local.tags

  default_action {
    allow {}
  }

  rule {
    name     = "rate-general"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_general_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-portals-rate-general"
    }
  }

  rule {
    name     = "rate-auth"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_auth_per_5min
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/v1/auth"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-portals-rate-auth"
    }
  }

  rule {
    name     = "ip-reputation"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-portals-ip-reputation"
    }
  }

  rule {
    name     = "common"
    priority = 11
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-portals-common"
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 12
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-portals-known-bad-inputs"
    }
  }

  dynamic "rule" {
    for_each = length(var.bot_control_paths) > 0 ? [1] : []
    content {
      name     = "bot-control-public-forms"
      priority = 20
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = "AWSManagedRulesBotControlRuleSet"
          scope_down_statement {
            regex_match_statement {
              regex_string = local.bot_control_regex
              field_to_match {
                uri_path {}
              }
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        sampled_requests_enabled   = true
        metric_name                = "${var.name}-portals-bot-control"
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    sampled_requests_enabled   = true
    metric_name                = "${var.name}-portals"
  }
}

resource "aws_wafv2_web_acl_logging_configuration" "cloudfront" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.cloudfront.arn
  log_destination_configs = [var.waf_log_group_arn_cloudfront]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
  redacted_fields {
    query_string {}
  }
}

# ---------------------------------------------------------------------------
# WAF: CloudFront scope (integrations. distribution)
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "integrations" {
  provider    = aws.us_east_1
  name        = "${var.name}-integrations"
  description = "integrations. distribution: no cookies, /public/v1 limits, IP reputation, known bad inputs"
  scope       = "CLOUDFRONT"
  tags        = local.tags

  default_action {
    allow {}
  }

  # The integrations host accepts no cookies: any request carrying a Cookie header is refused.
  rule {
    name     = "integrations-no-cookies"
    priority = 0
    action {
      block {}
    }
    statement {
      and_statement {
        statement {
          byte_match_statement {
            search_string         = local.integrations_host_match.search_string
            positional_constraint = "EXACTLY"
            field_to_match {
              single_header {
                name = "host"
              }
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
        statement {
          size_constraint_statement {
            comparison_operator = "GT"
            size                = 0
            field_to_match {
              single_header {
                name = "cookie"
              }
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-integrations-no-cookies"
    }
  }

  # /public/v1/* has its own limit (SHARED-BOUNDARIES 10.2).
  rule {
    name     = "rate-public-v1"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_public_per_5min
        aggregate_key_type = "IP"
        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = local.integrations_host_match.search_string
                positional_constraint = "EXACTLY"
                field_to_match {
                  single_header {
                    name = "host"
                  }
                }
                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/public/v1/"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-integrations-rate-public"
    }
  }

  rule {
    name     = "rate-integrations"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_integrations_per_5min
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = local.integrations_host_match.search_string
            positional_constraint = "EXACTLY"
            field_to_match {
              single_header {
                name = "host"
              }
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-integrations-rate"
    }
  }

  rule {
    name     = "ip-reputation"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
        scope_down_statement {
          byte_match_statement {
            search_string         = local.integrations_host_match.search_string
            positional_constraint = "EXACTLY"
            field_to_match {
              single_header {
                name = "host"
              }
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-integrations-ip-reputation"
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 11
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        scope_down_statement {
          byte_match_statement {
            search_string         = local.integrations_host_match.search_string
            positional_constraint = "EXACTLY"
            field_to_match {
              single_header {
                name = "host"
              }
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      sampled_requests_enabled   = true
      metric_name                = "${var.name}-integrations-known-bad-inputs"
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    sampled_requests_enabled   = true
    metric_name                = "${var.name}-integrations"
  }
}

resource "aws_wafv2_web_acl_logging_configuration" "integrations" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.integrations.arn
  log_destination_configs = [var.waf_log_group_arn_integrations]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
  redacted_fields {
    query_string {}
  }
}
