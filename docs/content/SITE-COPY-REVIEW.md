# Site copy review: first-release seed (HEAAA-799)

Seed version: `2026-11-11.2`. Source: `apps/cms/src/seed/copy.ts`. This file is generated from it and a test fails if they differ.

**Review status: authored by the Frontend Engineer; awaiting independent review. Not legal or clinical advice. Every legal page is a complete conservative default applied under the autonomous rule (go-live item 25, "default applied (autonomous)"); each statement describes only what this website does (HEAAA-838).** Owner ruling 2026-11-11 (C) item 5: no medical claims; the site never shows invented facts. † = counsel must confirm before go-live.

## Not seeded on purpose (the organisation enters these in the CMS `Organisation details` global at go-live)

Organisation name, address, phone, e-mail, hours and clinicians. The privacy and accessibility pages show the organisation’s phone, e-mail and address only when entered. The optional Notice of Privacy Practices (`legal.npp`) is entered by the organisation at go-live; while empty the page, its footer link, its sitemap entry and the link from the privacy page are omitted. Until entered, the site omits them (no placeholder fact, no fabricated value). Locations, services and doctors come from the directory API, not from this copy.

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
| `legal.privacy.body` | This public website does not ask for or store health information. It has no forms, accounts or comments, and it does not collect your name or contact details. Pages are the same for every visitor. ⏎ The software that runs this website does not keep a record of who visits. The hosting service may keep routine technical logs of requests (such as the time, the page asked for and the network address) to keep the site running and secure. ⏎ This website sets one essential cookie that remembers your cookie choice. Analytics are off until you choose Accept all, and they only count page visits and Book appointment clicks by type of page. The Cookies page lists exactly what is set. ⏎ When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice. The link can carry the service or doctor you were looking at, so the portal can start your booking in the right place. ⏎ Location pages can link to a map on OpenStreetMap. It opens in a new tab and is governed by that site's own privacy rules. ⏎ If you have a question about this notice, use the Contact page. ⏎ If this notice changes, the new version is posted on this page. | none | † |
| `legal.terms.title` | Terms of use | none | † |
| `legal.terms.description` | Terms for using this website. | none | † |
| `legal.terms.body` | The information on this website is general and is not medical advice. If this is an emergency, call 911. ⏎ This website is provided as is. We do not promise that it will always be available or free of errors, and the information on it may change without notice. ⏎ Please use the website only for its intended purpose: finding services, doctors and locations, and starting a booking. Do not try to disrupt it, to reach parts of it you are not meant to see, or to overload it with automated requests. ⏎ Links to other sites, including the patient portal and maps, lead to places we do not control. Their own terms and privacy notices apply there. ⏎ We may change these terms. The current version is always the one posted on this page. | none | † |
| `legal.cookies.title` | Cookies | none | † |
| `legal.cookies.description` | The cookies and analytics this website uses. | none | † |
| `legal.cookies.body` | This website sets one cookie. Its name is site_consent. It stores your choice, either essential only or accept all. It belongs to this website only, is sent only to this website, and lasts about six months. It is essential, because it is what remembers your choice, and it is not used to identify you. ⏎ This website sets no other cookies and does not use local storage or session storage in your browser. ⏎ Analytics are off until you choose Accept all. They count page visits and Book appointment clicks by type of page. They never receive names, doctors, services, locations or any health information. If analytics is switched on for this website and you choose Accept all, the analytics provider's script loads and may set its own cookies. Nothing from the provider loads if you choose essential only. ⏎ You can change your choice at any time with Cookie settings in the footer. ⏎ The patient portal is a separate site with its own cookies, described in its own notice. | none | † |
| `legal.accessibility.title` | Accessibility statement | none | † |
| `legal.accessibility.description` | How accessible this website is and how to ask for help. | none | † |
| `legal.accessibility.body` | We aim to meet WCAG 2.2 level AA. This statement does not claim a full manual audit. ⏎ If you cannot use part of this website, or find a barrier, contact us using the Contact page. Tell us the page, what you were trying to do, and any assistive technology you use, if you wish. ⏎ We aim to reply within five business days and, where we can, to offer another way to get what you need. | none | † |

Medical-claim screen (automated, see `review-doc.ts`): every string above is checked against a list of claim terms (cure, treat, heal, diagnose, guarantee, best, leading, proven, effective, expert, specialist, outcome, prevent, therapy, safe, clinically). A word list is a screen, not a substitute for the reviewer reading each line.
