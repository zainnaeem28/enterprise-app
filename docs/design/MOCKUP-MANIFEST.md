# Mockup manifest (HEAAA-14, draft 4 images; draft 6 desktop image, HEAAA-49)

Proposed design mockups. **Not runtime screenshots.** Placeholder brand, synthetic data. Draft; draft 6 review pending; not approved.

| File | Size (px) | SHA-256 |
| --- | --- | --- |
| `UI-Mockups-Desktop.png` | 2896 × 3210 | `5056d2e13a7e2607e1e7a1319ce0abc7bc7654f954458bc2693002b10d5ca17f` |
| `UI-Mockups-Mobile.png` | 1678 × 2184 | `01d432df7ad71afd3bb7e1da430a51844a7dfd4ba874ff025aa3ec7e52037a1b` |
| `mockup-src/UI-Mockups-Desktop.svg` | vector source | `f2919d09d8db37bd06428d98783fadf5521f2e825b3872d1a7a510393adb888f` |
| `mockup-src/UI-Mockups-Mobile.svg` | vector source | `7f0413d7b90f7f4bbc68431e364ae47af49c84924224e8cf1e6d112150a9ce27` |

Provenance: drawn by the UI/UX agent as SVG, rasterised with `@resvg/resvg-js` using Inter 4.0 (SIL OFL 1.1); first render 2026-11-04, re-rendered for draft 2 the same day. No stock, photographs or AI-generated images. Coverage: see UI-UX.md sections 4 and 5.

Changes from draft 1 (commit `8b2d3f4`): desktop 3 red-flag button "Dismiss" is now "Reassign"; desktop 2 cancellation sentence replaced by a marked placeholder; phone 1 "30+ clinics" replaced by "[clinic locations]"; phone 2 "Nothing was charged." removed; captions say draft 2. Both images were viewed by the author after re-rendering; no independent review yet.

Changes from draft 2 (`4f61820`): desktop 3 red-flag bar buttons "Alert doctor" and "Reassign" removed; the bar is now a read-only status ("Doctor alerted: [name]. Not yet acknowledged. Escalation time not set."). Captions say draft 3. Both images re-rendered; the desktop image was viewed by the author; no independent review yet.

Changes from draft 3 (`c9d6ef4`): desktop 3 triage-panel "Reassign" button removed (UXR-02 residual); captions say draft 4. Both images re-rendered; not independently reviewed.

Draft 5 (HEAAA-49, `UI-UX.md` only): no image or SVG changed; the hashes above are unchanged and equal `9dcb7aa`. The mockups do not show the allergy `null` state, countdown null cases, vital range states or release prompts; those are specified in text (UI-UX.md 7.4, 7.7, 8).

Draft 6 (HEAAA-49, UXR-08): desktop 3 red-flag bar text changed to "Red flag raised. The on-duty doctor has been alerted." (no name, no countdown, option B); caption says draft 6. Desktop PNG and SVG re-rendered with the same tooling (resvg, Inter); the mobile image and SVG are unchanged (hashes as in draft 4). The desktop image was viewed by the author after rendering; not independently reviewed. The PM check of the desktop image is pending and now covers this version.
