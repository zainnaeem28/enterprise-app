# edge module (DO-03, authored, not applied)

Per portal (`patient`, `staff`, `pharmacy`): private S3 bucket (OAC), CloudFront distribution, shared CloudFront-scope web ACL (needs the `aws.us_east_1` provider). One regional web ACL on the ALB for `integrations.`.

| Requirement | How it is expressed |
| --- | --- |
| `/api/*` never cached, cookies and `Authorization` forwarded | Managed-CachingDisabled cache policy + origin request policy (all cookies, `allViewer` headers incl. `Authorization` and `Host`, all query strings); no compression, no function |
| `release.json` forwards no cookie and never reaches the API | Own behaviour to the S3 origin with a cache policy that has no cookies/headers/query strings and no origin request policy |
| `integrations.` accepts no cookies | Not on CloudFront; WAF rule `integrations-no-cookies` (priority 0) blocks any request with a `Cookie` header on that host; ALB routes it by host only |
| `/public/v1/*` own rate limit | WAF rule `rate-public-v1` |
| SSE | CloudFront origin read timeout 30 s, ALB idle 60 s (compute), heartbeat 15 s |
| Entry document 60 s, assets immutable | Cache policies `entry` (60 s) and `assets` (1 year); `release.json` max 10 s |

No `custom_error_response`: it would rewrite API 403/404 to `index.html`. Client routing uses a viewer-request function on the default behaviour only.

## Open items

- Rate limits, CSP, and the Common rule set against partner webhooks are placeholders, **Unverified until staging**. AWS Bot Control (paid) is created only when `bot_control_paths` is set; the paths are not defined yet.
- CloudFront sends the viewer `Host` to the ALB, so the ALB certificate must cover all four hosts. SNI/validation behaviour is **Unverified until staging**.
- The 5-minute mixed-version window, invalidation (entry document and `release.json` only) and copying the entry document are release-pipeline steps, not in this module.
- WAF and CloudFront log destinations, the certificate, DNS records and the deploy role's S3 write rights are inputs / later tickets. Portal buckets use SSE-S3 (public bundles, no PHI); S3 access logging is not enabled on them.
