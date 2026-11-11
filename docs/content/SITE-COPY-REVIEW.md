# Site copy review: first-release seed (HEAAA-799)

Seed version: `2026-11-11.1`. Source: `apps/cms/src/seed/copy.ts`. This file is generated from it and a test fails if they differ.

**Review status: authored by the Frontend Engineer; awaiting independent review. Not legal or clinical advice.** Owner ruling 2026-11-11 (C) item 5: no medical claims; the site never shows invented facts. † = counsel must confirm before go-live.

## Not seeded on purpose (the organisation enters these in the CMS `Organisation details` global at go-live)

Organisation name, address, phone, e-mail, hours and clinicians. Until entered, the site omits them (no placeholder fact, no fabricated value). Locations, services and doctors come from the directory API, not from this copy.

## Seeded strings

| Key | Text | Medical claim | Counsel † |
| --- | ---- | ------------- | --------- |
| `home.heading` | Care that is easy to find and easy to book | none |  |
| `home.intro` | Find a service, choose a doctor and a location, and start your booking in a few steps. You sign in or create an account when you book, not before. | none |  |
| `about.intro` | On this site you can see our services, locations and doctors. | none |  |
| `about.booking` | You can book an appointment online. Choose a service, a doctor and a location, then sign in or create an account to finish. If you need to reach us, use the Contact page. | none |  |
| `contact.intro` | Choose the location nearest to you for its address and phone number. For anything urgent, call 911. | none | † |
| `legal.privacy.title` | Privacy | none | † |
| `legal.privacy.description` | How this website handles information. | none | † |
| `legal.privacy.body` | This public website does not ask for or store health information. Pages are the same for every visitor. ⏎ When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice. ⏎ This text is a placeholder until the organisation supplies its reviewed wording. | none | † |
| `legal.terms.title` | Terms of use | none | † |
| `legal.terms.description` | Terms for using this website. | none | † |
| `legal.terms.body` | The information on this website is general and is not medical advice. If this is an emergency, call 911. ⏎ This text is a placeholder until the organisation supplies its reviewed wording. | none | † |
| `legal.cookies.title` | Cookies | none | † |
| `legal.cookies.description` | The cookies and analytics this website uses. | none | † |
| `legal.cookies.body` | This website sets one essential cookie that remembers your cookie choice. It is not used to identify you. ⏎ Analytics are off until you choose Accept all. They count page visits by type of page. They never receive names, doctors, services, locations or any health information. You can change your choice at any time with Cookie settings in the footer. ⏎ This text is a placeholder until the organisation supplies its reviewed wording. | none | † |
| `legal.accessibility.title` | Accessibility statement | none | † |
| `legal.accessibility.description` | How accessible this website is and how to ask for help. | none | † |
| `legal.accessibility.body` | We aim to meet WCAG 2.2 level AA. This statement does not claim a full manual audit. ⏎ If you cannot use part of this website, contact the location nearest to you and tell us what you need. ⏎ This text is a placeholder until the organisation supplies its reviewed wording. | none | † |

Medical-claim screen (automated, see `review-doc.ts`): every string above is checked against a list of claim terms (cure, treat, heal, diagnose, guarantee, best, leading, proven, effective, expert, specialist, outcome, prevent, therapy, safe, clinically). A word list is a screen, not a substitute for the reviewer reading each line.
