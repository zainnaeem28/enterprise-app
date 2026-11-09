import type { CollectionConfig } from 'payload';

export const Banners: CollectionConfig = {
  slug: 'banners',
  labels: { singular: 'Banner', plural: 'Banners' },
  admin: {
    useAsTitle: 'message',
    description: 'Short notices shown across the brand site. No patient information.',
  },
  versions: { drafts: true, maxPerDoc: 10 },
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: 'published' } }),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'message', type: 'text', required: true, maxLength: 200 },
    {
      name: 'linkUrl',
      type: 'text',
      maxLength: 300,
      validate: (v: unknown) =>
        !v || /^(https:\/\/|\/)/.test(String(v))
          ? true
          : 'Use an https:// address or a path starting with /',
    },
  ],
};
