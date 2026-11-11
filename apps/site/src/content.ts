// Page copy that is not directory data, and the organisation's own facts. The live source is the self-hosted CMS
// (`apps/cms`, `cms-content.ts`; C-19, no SaaS CMS). `placeholderContent` is the static fallback used only while the CMS
// has not answered: it is the same reviewed first-release copy and holds NO organisation fact (name, address, phone,
// e-mail, hours and clinicians are empty), so falling back can never show an invented fact.
export interface LegalPage {
  title: string;
  description: string;
  paragraphs: string[];
}
/** Organisation facts, entered in the CMS by the organisation at go-live. `null` / empty means "not entered": show nothing. */
export interface Organisation {
  name: string | null;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  hours: string | null;
  clinicians: { name: string; title: string | null }[];
}
export interface ContentSource {
  home: { heading: string; intro: string };
  about: { intro: string; booking: string };
  contact: { intro: string };
  organisation: Organisation;
  legal: Record<'privacy' | 'terms' | 'cookies' | 'accessibility', LegalPage> & {
    /** Notice of Privacy Practices: optional. `null` until the organisation enters its body; then the page and its links are omitted. */
    npp: LegalPage | null;
  };
}

export const emptyOrganisation: Organisation = {
  name: null,
  addressLines: [],
  phone: null,
  email: null,
  hours: null,
  clinicians: [],
};

export const placeholderContent: ContentSource = {
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
  organisation: emptyOrganisation,
  legal: {
    privacy: {
      title: 'Privacy',
      description: 'How this website handles information.',
      paragraphs: [
        'This public website does not ask for or store health information. It has no forms, accounts or comments, and it does not collect your name or contact details. Pages are the same for every visitor.',
        'The software that runs this website does not keep a record of who visits. The hosting service may keep routine technical logs of requests (such as the time, the page asked for and the network address) to keep the site running and secure.',
        'This website sets one essential cookie that remembers your cookie choice. Analytics are off until you choose Accept all, and they only count page visits and Book appointment clicks by type of page. The Cookies page lists exactly what is set.',
        'When you choose Book appointment you move to the patient portal, which has its own sign-in and privacy notice. The link can carry the service or doctor you were looking at, so the portal can start your booking in the right place.',
        "Location pages can link to a map on OpenStreetMap. It opens in a new tab and is governed by that site's own privacy rules.",
        'If you have a question about this notice, use the Contact page.',
        'If this notice changes, the new version is posted on this page.',
      ],
    },
    terms: {
      title: 'Terms of use',
      description: 'Terms for using this website.',
      paragraphs: [
        'The information on this website is general and is not medical advice. If this is an emergency, call 911.',
        'This website is provided as is. We do not promise that it will always be available or free of errors, and the information on it may change without notice.',
        'Please use the website only for its intended purpose: finding services, doctors and locations, and starting a booking. Do not try to disrupt it, to reach parts of it you are not meant to see, or to overload it with automated requests.',
        'Links to other sites, including the patient portal and maps, lead to places we do not control. Their own terms and privacy notices apply there.',
        'We may change these terms. The current version is always the one posted on this page.',
      ],
    },
    cookies: {
      title: 'Cookies',
      description: 'The cookies and analytics this website uses.',
      paragraphs: [
        'This website sets one cookie. Its name is site_consent. It stores your choice, either essential only or accept all. It belongs to this website only, is sent only to this website, and lasts about six months. It is essential, because it is what remembers your choice, and it is not used to identify you.',
        'This website sets no other cookies and does not use local storage or session storage in your browser.',
        "Analytics are off until you choose Accept all. They count page visits and Book appointment clicks by type of page. They never receive names, doctors, services, locations or any health information. If analytics is switched on for this website and you choose Accept all, the analytics provider's script loads and may set its own cookies. Nothing from the provider loads if you choose essential only.",
        'You can change your choice at any time with Cookie settings in the footer.',
        'The patient portal is a separate site with its own cookies, described in its own notice.',
      ],
    },
    accessibility: {
      title: 'Accessibility statement',
      description: 'How accessible this website is and how to ask for help.',
      paragraphs: [
        'We aim to meet WCAG 2.2 level AA. This statement does not claim a full manual audit.',
        'If you cannot use part of this website, or find a barrier, contact us using the Contact page. Tell us the page, what you were trying to do, and any assistive technology you use, if you wish.',
      ],
    },
    npp: null,
  },
};
