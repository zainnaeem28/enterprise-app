// Reviewed first-release site copy (HEAAA-799, owner ruling 2026-11-11 C item 5). Plain words, NO medical claims and NO
// organisation facts: name, address, phone, e-mail, hours and clinicians are CMS entries the organisation fills in at
// go-live (`organisation` global) and are deliberately absent here. Every string is listed in docs/content/SITE-COPY-REVIEW.md
// (a test keeps the two in step). This file is pure data: apps/site imports it in tests to prove its static fallback
// equals it. Legal wording is a conservative default, NOT legal advice (marked † in the review doc: counsel confirms).
export const SEED_VERSION = '2026-11-11.2';

export interface LegalSeed {
  title: string;
  description: string;
  /** Paragraphs separated by one blank line in the CMS text area. */
  body: string;
}

export interface SiteContentSeed {
  home: { heading: string; intro: string };
  about: { intro: string; booking: string };
  contact: { intro: string };
  legal: Record<'privacy' | 'terms' | 'cookies' | 'accessibility', LegalSeed>;
}

export const siteContentSeed: SiteContentSeed = {
  home: {
    heading: 'Care that is easy to find and easy to book',
    intro:
      'Find a service, choose a doctor and a location, and start your booking in a few steps. You sign in or create an account when you book, not before.',
  },
  about: {
    intro: 'On this site you can see our services, locations and doctors.',
    booking:
      'You can book an appointment online. Choose a service, a doctor and a location, then sign in or create an account to finish. If you need to reach us, use the Contact page.',
  },
  contact: {
    intro:
      'Choose the location nearest to you for its address and phone number. For anything urgent, call 911.',
  },
  legal: {
    privacy: {
      title: 'Privacy',
      description: 'How this website handles information.',
      body: [
        'This public website does not ask for or store health information. It has no forms, accounts or comments, and it does not collect your name or contact details. Pages are the same for every visitor.',
        'The software that runs this website does not keep a record of who visits. The hosting service may keep routine technical logs of requests (such as the time, the page asked for and the network address) to keep the site running and secure.',
        'This website sets one essential cookie that remembers your cookie choice. Analytics are off until you choose Accept all, and they only count page visits and Book appointment clicks by type of page. The Cookies page lists exactly what is set.',
        'When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice. The link can carry the service or doctor you were looking at, so the portal can start your booking in the right place.',
        "Location pages can link to a map on OpenStreetMap. It opens in a new tab and is governed by that site's own privacy rules.",
        'If you have a question about this notice, use the Contact page.',
        'If this notice changes, the new version is posted on this page.',
      ].join('\n\n'),
    },
    terms: {
      title: 'Terms of use',
      description: 'Terms for using this website.',
      body: [
        'The information on this website is general and is not medical advice. If this is an emergency, call 911.',
        'This website is provided as is. We do not promise that it will always be available or free of errors, and the information on it may change without notice.',
        'Please use the website only for its intended purpose: finding services, doctors and locations, and starting a booking. Do not try to disrupt it, to reach parts of it you are not meant to see, or to overload it with automated requests.',
        'Links to other sites, including the patient portal and maps, lead to places we do not control. Their own terms and privacy notices apply there.',
        'We may change these terms. The current version is always the one posted on this page.',
      ].join('\n\n'),
    },
    cookies: {
      title: 'Cookies',
      description: 'The cookies and analytics this website uses.',
      body: [
        'This website sets one cookie. Its name is site_consent. It stores your choice, either essential only or accept all. It belongs to this website only, is sent only to this website, and lasts about six months. It is essential, because it is what remembers your choice, and it is not used to identify you.',
        'This website sets no other cookies and does not use local storage or session storage in your browser.',
        "Analytics are off until you choose Accept all. They count page visits and Book appointment clicks by type of page. They never receive names, doctors, services, locations or any health information. If analytics is switched on for this website and you choose Accept all, the analytics provider's script loads and may set its own cookies. Nothing from the provider loads if you choose essential only.",
        'You can change your choice at any time with Cookie settings in the footer.',
        'The patient portal is a separate site with its own cookies, described in its own notice.',
      ].join('\n\n'),
    },
    accessibility: {
      title: 'Accessibility statement',
      description: 'How accessible this website is and how to ask for help.',
      body: [
        'We aim to meet WCAG 2.2 level AA. This statement does not claim a full manual audit.',
        'If you cannot use part of this website, or find a barrier, contact us using the Contact page. Tell us the page, what you were trying to do, and any assistive technology you use, if you wish.',
        'We aim to reply within five business days and, where we can, to offer another way to get what you need.',
      ].join('\n\n'),
    },
  },
};

/** Every seeded string in a stable order, for the review document and the no-medical-claims test. */
export function seededStrings(): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const walk = (prefix: string, v: unknown): void => {
    if (typeof v === 'string') out.push({ key: prefix, text: v });
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(prefix === '' ? k : `${prefix}.${k}`, x);
  };
  walk('', siteContentSeed);
  return out;
}
