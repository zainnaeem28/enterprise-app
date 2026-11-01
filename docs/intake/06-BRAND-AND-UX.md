# 06 — Brand and User Experience

> **Status: CONFIRMED.** AI-prepared 2026-10-31. All sections Agreed by Zain Naeem (product owner) on 2026-10-31, and updated with his decisions of 2026-11-02 03:26 PKT (UTC+05:00) recorded in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).

## 1. Brand inputs

**Decision (2026-11-02):** the organisation **already has a brand**. The product owner will add the brand files to `docs/intake/brand/` before Plan & Design starts. The UI/UX agent applies that brand; it doesn't invent a new one.

| Item | Status |
| --- | --- |
| Organisation / product name for patients | Exists; to be supplied in `docs/intake/brand/` |
| Logo files (SVG/PNG, light and dark versions) | Exists; to be supplied |
| Brand colours (hex) and fonts | Exists; to be supplied |
| Tone of voice | Exists; to be supplied (or confirmed at G2) |
| Photography style, or permission to use stock imagery | Open |
| Languages at launch | English for R1 (other languages open) |
| Domain names (brand site, portal) | Open |

## 2. Experience principles (agreed)

- **Calm and trustworthy:** clean layouts, generous spacing, no clutter on clinical screens.
- **Fast for staff:** keyboard shortcuts, minimal clicks for frequent tasks (check-in, sign note, verify prescription), dense information where staff need it.
- **Simple for patients:** mobile-first, large touch targets, plain language, clear next steps.
- **Safe by design:** patient name, date of birth and photo always visible on clinical screens to prevent wrong-patient errors; destructive or risky actions confirm with clear consequences.
- **Consistent:** one shared design system (colours, type, spacing, components) across all six surfaces, with portal-specific accent colours so staff always know which portal they are in.

## 3. Brand site structure (agreed)

- Home: value proposition, services, "Book now", trust signals (accreditations, reviews)
- Services / specialties, each page with "Book this service"
- Find a doctor: filters for specialty, language, location, gender, availability
- Locations: map, hours, parking, accessibility information
- Prescriptions and partner pharmacies: how e-prescriptions, pharmacy choice and delivery tracking work
- Patient resources: FAQs, preparing for your visit, insurance and pricing
- About, careers, news/blog, contact
- Legal: privacy policy, terms, cookie policy, accessibility statement

## 4. Accessibility

WCAG 2.2 AA: colour contrast, keyboard navigation, screen-reader labels, captions for video content, focus states, reduced-motion support, and forms with clear error messages.

## 5. Deliverables expected in Plan & Design (for G2)

`UI-UX.md`, `BRAND-BRIEF.md`, and desktop and mobile mockups for representative screens of each portal. These are proposals for approval, not finished screens.
