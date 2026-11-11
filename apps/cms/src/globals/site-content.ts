import type { Field, GlobalConfig, TextField, TextareaField } from 'payload';

// Page copy for the brand site (ContentSource, apps/site). Public text only: never enter patient or health information.
const txt = (
  name: string,
  label: string,
  maxLength: number,
  area = false,
): TextField | TextareaField =>
  area ? { name, label, type: 'textarea', maxLength } : { name, label, type: 'text', maxLength };
const legalGroup = (name: string, label: string): Field => ({
  name,
  label,
  type: 'group',
  fields: [
    txt('title', 'Title', 120),
    txt('description', 'Short description (search results)', 300, true),
    {
      ...txt('body', 'Text', 6000, true),
      admin: { description: 'Separate paragraphs with one blank line.' },
    },
  ],
});

export const SiteContent: GlobalConfig = {
  slug: 'site-content',
  label: 'Site text',
  admin: {
    description: 'Headings and wording on the public site. No patient or health information.',
  },
  versions: { drafts: true, max: 25 },
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: 'published' } }),
    update: ({ req }) => Boolean(req.user),
  },
  fields: [
    {
      name: 'home',
      type: 'group',
      fields: [txt('heading', 'Heading', 160), txt('intro', 'Introduction', 600, true)],
    },
    {
      name: 'about',
      type: 'group',
      fields: [
        txt('intro', 'Introduction', 600, true),
        txt('booking', 'How booking works', 800, true),
      ],
    },
    { name: 'contact', type: 'group', fields: [txt('intro', 'Introduction', 600, true)] },
    {
      name: 'legal',
      type: 'group',
      fields: [
        legalGroup('privacy', 'Privacy'),
        legalGroup('terms', 'Terms of use'),
        legalGroup('cookies', 'Cookies'),
        legalGroup('accessibility', 'Accessibility statement'),
      ],
    },
    {
      name: 'seedVersion',
      type: 'text',
      admin: { hidden: true, readOnly: true },
    },
  ],
};
