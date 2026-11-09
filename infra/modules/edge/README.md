# edge module (DO-03, authored, not applied)

Per portal (`patient`, `staff`, `pharmacy`): private S3 bucket (OAC), CloudFront distribution, shared CloudFront-scope web ACL (needs the `aws.us_east_1` provider). Its own CloudFront distribution and CLOUDFRONT-scope web ACL for `integrations.` (HEAAA-573 D-F37-2). One CloudFront VPC origin to the internal ALB serves all four distributions; this module adds the ALB's only ingress rule (443 from the AWS-managed `CloudFront-VPCOrigins-Service-SG`, looked up after the VPC origin exists). There is no regional web ACL and no internet path to the ALB.

| Requirement                                                  | How it is expressed                                                                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/*` never cached, cookies and `Authorization` forwarded | Managed-CachingDisabled cache policy + origin request policy (all cookies, `allViewer` headers incl. `Authorization` and `Host`, all query strings); no compression, no function                               |
| `release.json` forwards no cookie and never reaches the API  | Own behaviour to the S3 origin with a cache policy that has no cookies/headers/query strings and no origin request policy                                                                                      |
| `integrations.` accepts no cookies                           | Own distribution; its origin request policy forwards no cookie and WAF rule `integrations-no-cookies` (priority 0) blocks any request with a `Cookie` header; the ALB rule also needs the origin-verify header |
| `/public/v1/*` own rate limit                                | WAF rule `rate-public-v1`                                                                                                                                                                                      |
| SSE                                                          | CloudFront origin read timeout 30 s, ALB idle 60 s (compute), heartbeat 15 s                                                                                                                                   |
| Entry document 60 s, assets immutable                        | Cache policies `entry` (60 s) and `assets` (1 year); `release.json` max 10 s                                                                                                                                   |

No `custom_error_response`: it would rewrite API 403/404 to `index.html`. Client routing uses a viewer-request function on the default behaviour only.

## Staging checklist (all **Unverified** until a staging environment exists, DELIVERY-PLAN C-01)

- A request from the internet to the ALB DNS name or its private addresses is not reachable; only CloudFront gets through.
- The `aws_security_group` lookup of `CloudFront-VPCOrigins-Service-SG` finds the group after the first VPC origin is deployed, and the ingress rule applies in one run (ordering and timeouts).
- A portal `/api/*` request and an SSE stream (heartbeat 15 s, origin read timeout 30 s) pass through the VPC origin without being cut.
- The ALB certificate covers all four hosts and CloudFront validates it over the VPC origin with the forwarded viewer `Host`.
- `integrations.`: webhook delivery (HMAC and Google `X-Goog-*` headers reach the API unchanged), `/public/v1` reads, cookie refusal, and the `integrations.` web ACL rules (rate limits, IP reputation, known bad inputs) end to end.
- Client address: the trusted `X-Forwarded-For` hop count is the same (CloudFront and ALB) for every host; the forged-XFF test covers `integrations.` and the portals (ARCHITECTURE 31.3 (d), OPEN-4). The value is recorded in deployment configuration.
- CloudFront and web ACL charges for `integrations.` against the cost table.

## Open items

- Rate limits, CSP, and the Common rule set against partner webhooks are placeholders, **Unverified until staging**. AWS Bot Control (paid) is created only when `bot_control_paths` is set; the paths are not defined yet.
- CloudFront sends the viewer `Host` to the ALB, so the ALB certificate must cover all four hosts, and the `integrations_certificate_arn` (us-east-1) must cover the integrations host. SNI/validation behaviour is **Unverified until staging**.
- The 5-minute mixed-version window, invalidation (entry document and `release.json` only) and copying the entry document are release-pipeline steps, not in this module.
- WAF and CloudFront log destinations, the certificate, DNS records and the deploy role's S3 write rights are inputs / later tickets. Portal buckets use SSE-S3 (public bundles, no PHI); S3 access logging is not enabled on them.
