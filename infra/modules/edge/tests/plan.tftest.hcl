mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:111111111111:global/webacl/t/11111111-1111-1111-1111-111111111111" }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::111111111111:function/t-spa-rewrite" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::111111111111:distribution/E1111111111111" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:111111111111:global/webacl/t/11111111-1111-1111-1111-111111111111" }
  }
}

variables {
  name = "t"
  portals = {
    patient  = { host = "my.example.test" }
    staff    = { host = "staff.example.test" }
    pharmacy = { host = "pharmacy.example.test" }
  }
  integrations_host             = "integrations.example.test"
  cloudfront_certificate_arn    = "arn:aws:acm:us-east-1:111111111111:certificate/11111111-1111-1111-1111-111111111111"
  alb_arn                       = "arn:aws:elasticloadbalancing:us-east-2:111111111111:loadbalancer/app/t-alb/1111111111111111"
  alb_dns_name                  = "t-alb-1.us-east-2.elb.amazonaws.com"
  origin_verify_secret          = "0123456789abcdef0123456789abcdef0123"
  cloudfront_logs_bucket_domain = "logs.s3.amazonaws.com"
  waf_log_group_arn_cloudfront  = "arn:aws:logs:us-east-1:111111111111:log-group:aws-waf-logs-t-cf"
  waf_log_group_arn_regional    = "arn:aws:logs:us-east-2:111111111111:log-group:aws-waf-logs-t-alb"
}

run "api_behaviour_is_uncached_and_forwards_everything" {
  command = plan
  assert {
    condition = alltrue([
      for d in aws_cloudfront_distribution.portal :
      one([for b in d.ordered_cache_behavior : b if b.path_pattern == "/api/*"]).cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    ])
    error_message = "/api/* must use the managed CachingDisabled policy"
  }
  assert {
    condition     = aws_cloudfront_origin_request_policy.api.cookies_config[0].cookie_behavior == "all" && aws_cloudfront_origin_request_policy.api.headers_config[0].header_behavior == "allViewer"
    error_message = "/api/* must forward all cookies and all viewer headers (Authorization, Host)"
  }
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : one([for b in d.ordered_cache_behavior : b if b.path_pattern == "/api/*"]).compress == false])
    error_message = "no compression on the API path (SSE)"
  }
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : length(d.default_cache_behavior[0].function_association) == 1 && length(one([for b in d.ordered_cache_behavior : b if b.path_pattern == "/api/*"]).function_association) == 0])
    error_message = "the SPA rewrite applies to the default behaviour only"
  }
}

run "release_json_has_no_cookies_and_never_reaches_the_api" {
  command = plan
  assert {
    condition     = aws_cloudfront_cache_policy.release.parameters_in_cache_key_and_forwarded_to_origin[0].cookies_config[0].cookie_behavior == "none"
    error_message = "release.json forwards no cookie"
  }
  assert {
    condition = alltrue([
      for d in aws_cloudfront_distribution.portal :
      one([for b in d.ordered_cache_behavior : b if b.path_pattern == "/release.json"]).target_origin_id == "portal-bucket"
      && one([for b in d.ordered_cache_behavior : b if b.path_pattern == "/release.json"]).origin_request_policy_id == null
    ])
    error_message = "release.json is served from S3 with no origin request policy"
  }
  assert {
    condition     = aws_cloudfront_cache_policy.entry.default_ttl == 60 && aws_cloudfront_cache_policy.entry.max_ttl == 60
    error_message = "entry document TTL is 60 s"
  }
}

run "sse_timeouts_and_tls" {
  command = plan
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : one([for o in d.origin : o if o.origin_id == "api-alb"]).custom_origin_config[0].origin_read_timeout == 30])
    error_message = "origin read timeout 30 s (> 15 s heartbeat)"
  }
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : d.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021" && one([for o in d.origin : o if o.origin_id == "api-alb"]).custom_origin_config[0].origin_protocol_policy == "https-only"])
    error_message = "TLS 1.2+ viewer side and https-only origin"
  }
}

run "integrations_host_is_not_behind_cloudfront_and_rejects_cookies" {
  command = plan
  assert {
    condition     = alltrue([for d in aws_cloudfront_distribution.portal : !contains(d.aliases, "integrations.example.test")])
    error_message = "integrations. must not be served by CloudFront"
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.regional.rule : r if r.name == "integrations-no-cookies"]).priority == 0
    error_message = "cookie rejection must be first"
  }
  assert {
    condition     = length([for r in aws_wafv2_web_acl.regional.rule : r if r.name == "rate-public-v1"]) == 1
    error_message = "/public/v1/* needs its own rate rule"
  }
}

run "bot_control_off_without_paths_on_with_paths" {
  command = plan
  assert {
    condition     = length([for r in aws_wafv2_web_acl.cloudfront.rule : r if r.name == "bot-control-public-forms"]) == 0
    error_message = "paid Bot Control must not exist without approved paths"
  }
}

run "bot_control_with_paths" {
  command = plan
  variables {
    bot_control_paths = ["/api/v1/public/forms"]
  }
  assert {
    condition     = length([for r in aws_wafv2_web_acl.cloudfront.rule : r if r.name == "bot-control-public-forms"]) == 1
    error_message = "Bot Control expected"
  }
}

run "wrong_portal_keys_rejected" {
  command = plan
  variables {
    portals = { patient = { host = "my.example.test" } }
  }
  expect_failures = [var.portals]
}
