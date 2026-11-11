// Page copy that is not directory data. Neutral default wording (no invented facts).
// This is the seam for the content source decided by C-19 (self-hosted CMS or SaaS CMS, FE-16): when it lands, an
// implementation of `ContentSource` replaces `defaultContent` and nothing else in the site changes.
export interface LegalPage {
  title: string;
  description: string;
  paragraphs: string[];
}
export interface ContentSource {
  home: { heading: string; intro: string };
  about: { intro: string; booking: string };
  contact: { intro: string; email: string | null; phone: string | null; hours: string | null };
  legal: Record<'privacy' | 'terms' | 'cookies' | 'accessibility', LegalPage>;
}

const pending = 'For questions about this page, use the Contact page.';

export const defaultContent: ContentSource = {
  home: {
    heading: 'Care that is easy to find and easy to book',
    intro:
      'Find a service, choose a doctor and a location, and start your booking in a few steps. You sign in or create an account when you book, not before.',
  },
  about: {
    // PM-drafted first-release copy (HEAAA-275): plain words, no claims. Brand-supplied copy (C-16/C-19) replaces it.
    intro:
      'We are a medical practice. You can see our services, locations, hours and doctors on this site.',
    booking:
      'You can book an appointment online. Choose a service, a doctor and a location, then sign in or create an account to finish. If you need to reach us, use the Contact page.',
  },
  contact: {
    intro:
      'Choose the location nearest to you for its address and phone number. For anything urgent, call 911.',
    email: null,
    phone: null,
    hours: null,
  },
  legal: {
    privacy: {
      title: 'Privacy',
      description: 'How this website handles information.',
      paragraphs: [
        'This public website does not ask for or store health information. Pages are the same for every visitor.',
        'When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice.',
        pending,
      ],
    },
    terms: {
      title: 'Terms of use',
      description: 'Terms for using this website.',
      paragraphs: [
        'The information on this website is general and is not medical advice. If this is an emergency, call 911.',
        pending,
      ],
    },
    cookies: {
      title: 'Cookies',
      description: 'The cookies and analytics this website uses.',
      paragraphs: [
        'This website sets one essential cookie that remembers your cookie choice. It is not used to identify you.',
        'Analytics are off until you choose Accept all. They count page visits by type of page. They never receive names, doctors, services, locations or any health information. You can change your choice at any time with Cookie settings in the footer.',
        pending,
      ],
    },
    accessibility: {
      title: 'Accessibility statement',
      description: 'How accessible this website is and how to ask for help.',
      paragraphs: [
        'We aim to meet WCAG 2.2 level AA. Automated checks run on every release; this statement does not claim a full manual audit.',
        'If you cannot use part of this website, contact the location nearest to you and tell us what you need.',
        pending,
      ],
    },
  },
};
