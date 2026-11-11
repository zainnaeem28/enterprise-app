import type { GlobalConfig } from 'payload';

// Organisation facts. Intentionally EMPTY until the organisation fills them in at go-live: the site shows a fact only when
// it is entered here and omits it otherwise (it never shows an invented one). Public information only.
export const Organisation: GlobalConfig = {
  slug: 'organisation',
  label: 'Organisation details',
  admin: {
    description:
      'Name, address, phone, e-mail, hours and clinicians shown on the public site. Leave a field empty to show nothing.',
  },
  versions: { drafts: true, max: 25 },
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: 'published' } }),
    update: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 120 },
    {
      name: 'address',
      type: 'textarea',
      maxLength: 400,
      admin: { description: 'One line per line of the address.' },
    },
    { name: 'phone', type: 'text', maxLength: 40 },
    { name: 'email', type: 'email' },
    { name: 'hours', type: 'textarea', maxLength: 300 },
    {
      name: 'clinicians',
      type: 'array',
      maxRows: 100,
      fields: [
        { name: 'name', type: 'text', required: true, maxLength: 120 },
        { name: 'title', type: 'text', maxLength: 120 },
      ],
    },
  ],
};
