# integrations-host module (BE-22)

Owner: Backend Engineer. No migration. Design: ARCHITECTURE 29.5, 22.5.1, 21.3, 25.7; SHARED-BOUNDARIES 5.1, 6.1, 10.2; SEC-01 (PB-1, PB-2, PB-4, DF-3, DF-4).

## Routes

| Route                                                                | Auth                         | Behaviour                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /public/v1/services` (`?locationId`)                            | none, audience `public`      | `organisation.directoryServices` over the C0 views. Fields: `id`, `patientDisplayName`, `durationMin`, `mode`. `Cache-Control: public, max-age=60`.                                                                |
| `GET /public/v1/locations`                                           | none                         | `organisation.directoryLocations`. Active locations only (the view).                                                                                                                                               |
| `GET /public/v1/clinicians` (`?serviceId`, `?locationId`)            | none                         | `identity.public_clinician` (listed, active, `google` realm) intersected with `scheduling.public_clinician_location` (active, unended template, at the place when asked) and the service's clinicians.             |
| `POST /webhooks/video/{vendor}`, `POST /webhooks/messaging/{vendor}` | vendor signature, per source | Raw bytes -> integration-core `InboundReceiver` (verify, seal, one transaction `receive_inbound` + dispatch job). `200` for new and duplicate, `401` failed verification (not stored), `400`, `404`, `413`, `503`. |
| `POST /webhooks/google/calendar`                                     | channel token                | Stays in calendar-sync (BE-14).                                                                                                                                                                                    |

Not here: `GET /public/v1/clinicians/{id}/next-available` needs the definer function `scheduling.next_available` (21.3), which no migration creates yet; it belongs to scheduling.

## Rules this module enforces

- **Audience `public`, read-only.** Every public read runs `withScope({audience: 'public', orgId})` (org from deployment configuration, never the request) and `SET LOCAL transaction_read_only = on`. The database lets `public` read only the nine C0 views, so a row that is not publishable never reaches the code.
- **No cookies.** `NoCookiesGuard` drops the `Cookie` header and any `Set-Cookie` before a handler runs; a session cookie sent to the host changes no answer (byte-identical, tested) and authenticates nothing.
- **Only GET under `/public/v1`.** Other verbs are not routed (404/405). Unknown query parameters are `400` (CN-12; they would also split the CDN cache key). Unknown, inactive and unlisted IDs give the same empty list: no oracle.
- **Cache.** `public, max-age=60` on a successful public answer only; errors and webhooks are `no-store`. No `Set-Cookie`, no per-user header, so the CDN key is path and query only (PB-4 review item).
- **Webhooks.** Body at most 256 KB. Verification keys and rules are integration-core's; the source is `<kind>.<vendor>` and an unregistered one is `404`. Nothing from the request is logged here.

## Composition (root, at start-up)

```ts
const directory = new PublicDirectoryService({
  db,
  orgId,
  organisation,
  scheduling: availabilityService,
});
const controllers = createIntegrationsHostControllers({
  directory,
  receiver: new InboundReceiver({
    db,
    queue,
    sealer,
    keys,
    orgId,
    verifiers /* 'video.<vendor>' -> verifier */,
  }),
});
```

No vendor verifier is registered by this module: vendor-specific schemes arrive with their adapter tickets, and no vendor was contacted.

## Open items (need someone outside this ticket's allowed paths)

1. **Raw body for JSON webhooks.** Resolved by the platform correction HEAAA-183 (commit `9914cfd`: `verifyBodySize` sets `req.rawBody` for `/webhooks/*`). `rawBodyOf` still answers `503` if a parsed body arrives with no raw copy (fail closed). The dbtest drives signed JSON (valid, duplicate, tampered) through the real `createApp` parser. This module's candidate must be integrated together with that commit.
2. **Module graph.** This module imports no other module (ports only), so `eslint/module-graph.mjs` needs no edit; adding `integrations-host` to a layer is only needed if a later change imports another module directly.
3. **`next-available`** as above.
4. Composition root registration (`apps/api/src/main.ts`) belongs to the integrator.
