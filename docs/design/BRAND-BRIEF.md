# BRAND-BRIEF — Enterprise EHR Platform

| Field | Value |
| --- | --- |
| Task | HEAAA-14 `[SDLC:ux-design]` |
| Author | UI/UX Designer agent (`1ddacad6-d28d-4bff-a938-a6957593b3ff`) |
| Version | Draft 2 (mockups revised after PM review round 1; brand content unchanged) |
| Status | **DRAFT. Round 2 review pending. Not human-approved. Not G2.** |
| Inputs | Intake pack rev 2 (`docs/intake/06-BRAND-AND-UX.md`, commit `6ea01b5`); PRD rev 3 (HEAAA-11 `prd`); ARCHITECTURE (HEAAA-11 `architecture`); SHARED-BOUNDARIES rev 3 (HEAAA-12) |

## 1. Brand evidence: what exists and what does not

The owner decided on 2026-11-02 that the organisation **already has a brand** and would add the files to `docs/intake/brand/` before Plan & Design `[06 §1]`. **That folder does not exist in the repository at this revision** (checked in the HEAAA-14 worktree, base commit `6ea01b5`). So there is no supplied evidence for any of these:

| Item | Status | Effect |
| --- | --- | --- |
| Product / organisation name for patients | **Missing** | Mockups show `[Product name]` |
| Logo (SVG/PNG, light and dark) | **Missing** | Mockups show a neutral square "P" placeholder. It is not a logo proposal |
| Brand colours (hex) | **Missing** | Section 3 gives **placeholder** tokens |
| Fonts | **Missing** | Placeholder: Inter (SIL OFL 1.1). Not a brand font |
| Tone of voice | **Missing** | Section 6 gives working rules for safety and plain language only |
| Photography style or stock permission | **Open** | Mockups use no photographs. Initials avatars only |
| Languages at launch | English assumed for R1 (`[07 B8]` Open) | Layouts leave room for 30 % longer text |
| Domain names | Open | Mockups use `[domain]` |

**I did not invent a brand.** The tokens below exist so layout, contrast and accessibility can be designed and checked now. They are a **proposal-level stand-in**. When the brand files arrive, only the values in section 3 change. Structure, spacing, component behaviour and the portal-accent rule stay. Every changed colour must pass the contrast table in section 4 again.

**Blocker for G2 (not for review):** G2 should not approve the visual identity until the owner supplies the brand files or states that the placeholder is acceptable. Required input: the files in `docs/intake/brand/`, or a decision in the G2 package. This is raised to Orchestrator in the task report.

## 2. Principles carried from the intake (agreed `[06 §2]`)

- Calm and trustworthy: generous space, no clutter on clinical screens.
- Fast for staff: dense tables, keyboard shortcuts, few clicks for check-in, sign note, verify prescription.
- Simple for patients: mobile-first, large touch targets, plain language, one clear next step.
- Safe by design: patient name, date of birth and photo on every clinical screen (BR-34); risky actions state their consequence.
- Consistent: one design system, **portal-specific accent colours so staff always know which portal they are in**.

## 3. Placeholder design tokens (Proposal)

### 3.1 Colour

| Token | Value | Use |
| --- | --- | --- |
| `ink` | `#1B2430` | Body text |
| `muted` | `#4A5565` | Secondary text |
| `bg` | `#F4F6F8` | Page background |
| `surface` | `#FFFFFF` | Cards, inputs, app bar |
| `border` | `#C9D1DB` | Decorative card edges only |
| `border-control` | `#6B7685` | Input and control borders (needs 3:1) |
| `focus` | `#1F4FD8` | Focus ring, 3 px with 2 px white offset |
| `danger` / tint | `#B42318` / `#FDECEA` | Errors, red flags, out-of-range, destructive |
| `warning` / tint | `#7A4B00` / `#FFF3D1` | Holds, stale data, attention |
| `success` / tint | `#1B6B3A` / `#E3F4E8` | Done, ready, allowed |
| `info` / tint | `#1F5FA8` / `#E4EEF9` | Neutral status |

Portal accents (header bar, active tab, primary button; the portal **name is always written** in the header, so colour is never the only cue):

| Surface | Accent | Host |
| --- | --- | --- |
| Brand site | `#0B6E79` (teal) | `www.` |
| Patient portal | `#0B6E79` (teal) | `my.` |
| Pre-consultation | `#6A4BB0` (violet) | `staff.` |
| Doctor | `#1F5FA8` (blue) | `staff.` |
| Partner pharmacy | `#276B3A` (green) | `pharmacy.` |
| System admin | `#8A3B12` (rust) | `staff.` (admin realm) |

The brand site and patient portal share an accent because they are one visitor-to-patient experience. Admin uses a distinct accent plus a banner, because it is a different sign-in realm on the same host (SHARED-BOUNDARIES 7.2.4).

### 3.2 Type, space, shape

| Token | Value |
| --- | --- |
| Font | Inter (placeholder). System font stack fallback. Self-hosted, no third-party font calls (BR-36) |
| Scale (px) | 12 caption (staff tables only), 14 body staff, 16 body patient, 18, 20, 24, 30 headings |
| Patient body size | 16 px minimum on phone to avoid iOS zoom on inputs |
| Line height | 1.5 body, 1.25 headings |
| Spacing | 4 px base: 4, 8, 12, 16, 24, 32, 48 |
| Radius | 6 controls, 8 buttons, 10 cards, full for chips |
| Touch target | 44 × 44 px minimum on touch layouts (WCAG 2.5.8 needs 24; the design uses 44). Desktop controls 36–40 px |
| Motion | 150 ms fades. No motion that carries meaning. All motion respects `prefers-reduced-motion` |
| Elevation | Borders first; one soft shadow only for menus and dialogs |

### 3.3 Components shared by all surfaces (names for the library)

App bar with portal label · Tabs · Data table with sticky header · Status chip (icon + text + colour) · Banner (info, warning, danger) · Form field with label, hint, error · Slot button · Stepper · Dialog (confirm risk) · Toast (non-critical only) · Empty state · Skeleton · Patient banner · Timeline · Alert bar (staff).

## 4. Contrast evidence (calculated, WCAG 2.x relative luminance)

Computed with a script over the placeholder tokens on 2026-11-04. These are calculated ratios, not a tool audit of a running UI.

| Pair | Ratio | Needs | Result |
| --- | --- | --- | --- |
| `ink` on white / on `bg` | 15.65 / 14.45 | 4.5 | Pass |
| `muted` on white / on `bg` | 7.56 / 6.98 | 4.5 | Pass |
| White on teal `#0B6E79` | 5.96 | 4.5 | Pass |
| White on violet `#6A4BB0` | 6.47 | 4.5 | Pass |
| White on blue `#1F5FA8` | 6.44 | 4.5 | Pass |
| White on green `#276B3A` | 6.46 | 4.5 | Pass |
| White on rust `#8A3B12` | 7.73 | 4.5 | Pass |
| `danger` on white / tint; white on `danger` | 6.57 / 5.75 / 6.57 | 4.5 | Pass |
| `warning` on tint | 6.70 | 4.5 | Pass |
| `success` on tint | 5.72 | 4.5 | Pass |
| `info` on tint | 5.49 | 4.5 | Pass |
| Teal on `primaryTint` | 5.14 | 4.5 | Pass |
| Disabled text `#5B6573` on `#E6EAEF` | 4.89 | exempt, kept ≥ 4.5 | Pass |
| `border-control` on white | 4.61 | 3 (1.4.11) | Pass |
| `focus` on white / on `bg` | 6.63 / 6.12 | 3 | Pass |
| `border` on white | 1.54 | not required: edges are decorative; content and controls have their own contrast | Accepted, decorative only |

## 5. Imagery and iconography rules

- No stock photos or generated people until the owner decides (photography row in section 1). Doctor photos come from the clinic with consent. Missing photo shows initials.
- Icons are line icons from one set, always paired with text for status and actions. Icon licence is chosen at build (Architect/Frontend); it must be permissive and self-hosted.
- No imagery that implies a diagnosis on any surface that can leave the platform (BR-23 extension): brand-site service names use the neutral display name where a name would reveal a condition.

## 6. Tone of voice: working rules until the brand supplies its own

- Plain words, short sentences, reading age about 8th grade. Say what happened, what it means, what to do next.
- No blame in errors. No jargon. No exclamation marks in clinical or error text.
- Never put a diagnosis, test name or medicine name in a notification, email, SMS, calendar entry or payment descriptor (BR-23). The prompt is: "You have an update. Sign in to view it."
- Emergency text is fixed and reviewed by the clinical safety reviewer before release: "If this is an emergency, call 911." (Wording and jurisdiction to be confirmed; see UI-UX.md section 14.)

## 7. How to apply the real brand when it arrives

1. Owner adds files to `docs/intake/brand/` (logo SVG light/dark, colours hex, fonts with licence, tone notes).
2. UI/UX maps their palette to the token names in section 3.1 and reruns the contrast table.
3. If the brand has no accessible equivalent for a role (for example a light brand colour that fails 4.5:1 on white), UI/UX proposes the nearest passing shade and records the deviation for the owner.
4. Portal accents stay distinct from one another and from `danger`, whatever the brand colours are.
5. Mockups are regenerated from the same source and re-reviewed. This invalidates the G2 review of the previous mockup revision.

## 8. Licensing and provenance

| Asset | Provenance | Licence | Status |
| --- | --- | --- | --- |
| `UI-Mockups-Desktop.png`, `UI-Mockups-Mobile.png` | Drawn by the UI/UX agent as vector shapes in SVG and rasterised with `@resvg/resvg-js` on 2026-11-04. Sources in `docs/design/mockup-src/`. No stock, photographs, AI image generation or third-party artwork | Own work, no third-party content except the font | **Proposed design mockups. Not runtime screenshots** |
| Inter font (in the images only) | rsms/inter v4.0 release archive | SIL Open Font License 1.1 | Placeholder font |
| All people, names, dates, MRNs | Synthetic ("Sample", `SYN-000123`) | n/a | Synthetic only (BR-35) |
