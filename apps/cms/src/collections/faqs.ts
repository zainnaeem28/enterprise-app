import type { CollectionConfig } from 'payload';

export const Faqs: CollectionConfig = {
  slug: 'faqs',
  labels: { singular: 'FAQ', plural: 'FAQs' },
  admin: {
    useAsTitle: 'question',
    description: 'Questions and answers for the public FAQ. No patient information.',
  },
  versions: { drafts: true, maxPerDoc: 10 },
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: 'published' } }),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'question', type: 'text', required: true, maxLength: 200 },
    { name: 'answer', type: 'textarea', required: true, maxLength: 2000 },
  ],
};
