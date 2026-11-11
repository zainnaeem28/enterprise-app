# HEAAA-791 decision log (review round 1)

Owner of the decision: Backend Engineer (implementation detail inside the approved contract); reviewed by the Backend Reviewer on HEAAA-792.

## BR-PROXY-04: `messages` scope exposes the thread list only
- Question: should a proxy holding `messages` read the messages of a thread?
- Options: (a) list only now; (b) add `GET /threads/{id}/messages` for proxies.
- Choice: (a). Reading messages (`/threads/{id}/messages`) is staff-only today (known limit O-2 of the messaging module); opening it to proxies is a change to the messaging module's contract and is outside this ticket's allowed paths. Row-level security already permits the rows (`thread_proxy_select`, `message_patient_select`), so the later route change needs no schema change.
- Follow-up: the messaging module owner opens the read route to a proxy with the `messages` scope when O-2 is lifted; add it to `PROXY_SCOPED_ROUTES` in the same change.
- Reversible: yes (no data migration).

## BR-PROXY-05: invite code hardening
- Question: HMAC with a server-side key instead of a salted SHA-256 for `code_hash`?
- Choice: keep salted SHA-256 for this candidate; record the hardening as a follow-up. A key would have to reach both the API (verify) and the worker (hash), which is a configuration and secret-handling change (new secret, rotation, deploy order) that belongs to DevOps/Cybersecurity, not to this ticket. The compensating controls are in place: the code is single-use, expires after `proxy_invite_hours`, the attempt limit (`proxy_code_max_attempts`) locks the grant, `code_hash` is readable only by the invitee under row-level security and by the worker, and no code appears in audit rows.
- Follow-up: Cybersecurity to decide on a keyed hash; the hash function is isolated in `hashInviteCode` (worker) and the matching check in `ProxyService.accept`.
- Retry: a job retry resets `attempts` to 0 only because a retry follows a failed send, so no delivered code is ever given more guesses (comment added in `runSendProxyInvite`).
