# FE-09 evidence manifest (HEAAA-119)

Base commit (prerequisite merges, unchanged): f9722c7e4182f23309099052954be3b81062425b. Candidate = the commit that adds this folder; diff: `git diff f9722c7e4182f23309099052954be3b81062425b -- apps/staff/src/features/preconsult`.
Tools: node v24.22.2, vitest vitest/5.1.0 linux-x64 node-v24.22.2, playwright Version 1.64.1, chromium headless shell 1248 (axe in specs).

| Check | Command (from apps/staff unless noted) | Raw report | Result |
| --- | --- | --- | --- |
| Typecheck | `pnpm exec tsc -p tsconfig.json --noEmit` | raw/typecheck-staff.txt | exit 0 |
| Unit (jsdom, whole staff app incl. desk.test.tsx, qr.test.ts) | `NODE_ENV=test pnpm exec vitest run` | raw/unit-staff.txt | 8 files, 82 tests passed (one earlier run showed a StaffApp.test failure, FE-08 file, not reproducible in 3 re-runs; treat as flaky under load) |
| Playwright PR subset + axe on every screen, desktop 1280 and phone 390 | `pnpm exec playwright test -c src/features/preconsult/e2e/playwright.config.ts` | raw/playwright.txt, playwright-report.json | 16 passed |
| Lint | `pnpm exec eslint apps/staff/src/features/preconsult` (root) | raw/lint.txt | exit 0 |
| Format | prettier --check on sources | raw/format.txt | exit 0 |
| QR independent decode | raw/qr-decode-check.mjs | raw/qr-decode-check.txt | 205/205 decoded |
| TC-PC-15 legibility | human | n/a | PENDING (human) |

All API traffic in these tests is contract mocks; no real API/DB was exercised. Screenshots (sha256):

```
e2f60865839b4e9136e0b389523e523a7c503b4ee51e7e18bd7a1cac1e31735a  desktop-1-arrivals.png
891e9edc92f626eda45e5d21767edb7924d96f673924b988da54ae8c0c49499d  desktop-10-duplicates-no-merge.png
45c6bb0f9fe909bbcfc12feacc224ee04c18728d28f613359007fb54f1ec6dfa  desktop-11-merge-request.png
6d3683f3418f18da2423f5311525e24f5ca97e4477674f8bb059ed532428fcdb  desktop-12-merge-approve.png
470b3aee948b32bbc9461082ded8e8d046e1dac8b1f85c2dd8ca9dc01c46c7d1  desktop-13-follow-ups.png
8c04585b567e0d118a30df47a3659db976bf94a2b9f4cb69847896a651e13d07  desktop-14-no-shows.png
360c6b539f9ed669cc907b38c847cdcc6eccff364df5f8501d1df291ee2d458c  desktop-2-checked-in.png
de76595b76acbd5e45fdb9ee99768cb659427405ec291985091812a6e5ca8ec3  desktop-3-check-in-qr.png
2774eb0a0deecb414963940e5955a223ff17d795d970d74d83549d9cd234a396  desktop-4-queue.png
aedba35966300faab0ea8ad3b5ec0393c2e5427cc3761b82bfa2914ca9b74f28  desktop-5-vitals.png
2c575c070de7f48dda510a30c919bfd1e13fdacc1ce4b15b2f68be4ed6a233c1  desktop-6-red-flag.png
3ca15771ce4a64e3464b3b3f4ad8d75f35623c47cb5b10d82aa615916bf36b05  desktop-7-allergy-hidden.png
bbec6b5ea3dff9b0dbfe61b63a46fa6ea2113b425d077e3a0b357450e1560be6  desktop-8-forms.png
98883ee8a67c82d5dd0e0d0107a862b1c8dd3f49ec9d463b0e9fdf7a4d129ea8  desktop-9-duplicate-warning.png
bafbe0b299434df930b8410b7614461fff5b1455e327920e4fee4196d69bf152  phone-1-arrivals.png
79827c811dab42d64f1318f5abd3c513ee86fb4ddea09a1bae73ea9cff2063a0  phone-10-duplicates-no-merge.png
f7f8f863b224bb9c983b14c9df19edc36829113ad5257bfcadc71c8834a27385  phone-11-merge-request.png
c4e176f2ce5605b1beaf6cb1300384be67314df13925f04d8b08954a36c50f87  phone-12-merge-approve.png
86587f03c4f3bd5f4abc8a2901fb78306d85462056e892644ffc2a0ff4a8d754  phone-13-follow-ups.png
a67046b5227712d84899c03411b5d59d6e59756cdb28d1e278255b14d04e637c  phone-14-no-shows.png
5c73f006326e94ca05e5295f8387f94db9e62c3bd6b4cdb2e70032e8a9fe4982  phone-2-checked-in.png
a96a8c00818eb5778e052cbce5613e53826084c95fb384a658d467a89106a94e  phone-3-check-in-qr.png
ebf6f45a73972d42fd8d6172bbc654eeea30370b716771e9364abe5f6f58a194  phone-4-queue.png
c1421ee9d11233146c5490df111c906dab0e9b2d1e09287c6b2e87477db6a9de  phone-5-triage-phone-note.png
b5f1d758e46e21669c6de372f4dd507d3aeb30f577d1be51932ac3eb9b542447  phone-5-vitals.png
8ae4492df168027bd87c3e2368dc942d0abdaf29223826e812aa4b0583ec6094  phone-6-red-flag.png
701fa048c6458609f9a7182c4448b21d548137f79e78bb3145f1121b2b9959fc  phone-7-allergy-hidden.png
bb8e84f61d56ddda7fcb471fe3b58113d57cb8e17330d9bed8e5dc0f00a97e31  phone-8-forms.png
abac6b5a26237e457fec06d1b4f43a7afa9a447d6f5d68c63b6f4a2107a31805  phone-9-duplicate-warning.png
```
