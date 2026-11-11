// Reviewed first-release site copy (HEAAA-799, owner ruling 2026-11-11 C item 5). Plain words, NO medical claims and NO
// organisation facts: name, address, phone, e-mail, hours and clinicians are CMS entries the organisation fills in at
// go-live (`organisation` global) and are deliberately absent here. Every string is listed in docs/content/SITE-COPY-REVIEW.md
// (a test keeps the two in step). This file is pure data: apps/site imports it in tests to prove its static fallback
// equals it. Legal wording is a conservative default, NOT legal advice (marked † in the review doc: counsel confirms).
export const SEED_VERSION = '2026-11-11.1';

const pending = 'This text is a placeholder until the organisation supplies its reviewed wording.';

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
        'This public website does not ask for or store health information. Pages are the same for every visitor.',
        'When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice.',
        pending,
      ].join('\n\n'),
    },
    terms: {
      title: 'Terms of use',
      description: 'Terms for using this website.',
      body: [
        'The information on this website is general and is not medical advice. If this is an emergency, call 911.',
        pending,
      ].join('\n\n'),
    },
    cookies: {
      title: 'Cookies',
      description: 'The cookies and analytics this website uses.',
      body: [
        'This website sets one essential cookie that remembers your cookie choice. It is not used to identify you.',
        'Analytics are off until you choose Accept all. They count page visits by type of page. They never receive names, doctors, services, locations or any health information. You can change your choice at any time with Cookie settings in the footer.',
        pending,
      ].join('\n\n'),
    },
    accessibility: {
      title: 'Accessibility statement',
      description: 'How accessible this website is and how to ask for help.',
      body: [
        'We aim to meet WCAG 2.2 level AA. Automated checks run on every release; this statement does not claim a full manual audit.',
        'If you cannot use part of this website, contact the location nearest to you and tell us what you need.',
        pending,
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
