import type { CollectionConfig } from 'payload';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { validateSlug } from '../lib/slug';
import { previewUrl } from '../admin/preview';
import { loadCmsEnv } from '../lib/env';

// Brand-site pages (F-BS-04). Public content only: no PHI field exists, and the rich-text editor is Lexical, which
// stores a structured tree rather than raw HTML (ARCHITECTURE 8 threat 13: sanitising editor). Draft / publish uses
// Payload versions, so a marketing user can edit, preview and publish without a developer.
export const Pages: CollectionConfig = {
  slug: 'pages',
  labels: { singular: 'Page', plural: 'Pages' },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', '_status', 'updatedAt'],
    description: 'Public pages on the brand site. Never enter patient or health information here.',
    preview: (doc) => {
      const env = loadCmsEnv(process.env);
      return previewUrl({
        siteOrigin: env.sitePreviewUrl,
        secret: env.previewSecret,
        slug: String(doc['slug'] ?? ''),
        ttlSeconds: env.previewTtlSeconds,
      });
    },
  },
  versions: { drafts: { autosave: { interval: 2000 } }, maxPerDoc: 25 },
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: 'published' } }),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'title', type: 'text', required: true, maxLength: 120 },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: validateSlug,
      admin: {
        position: 'sidebar',
        description: 'Path on the site, for example "about" or "services/cardiology".',
      },
    },
    {
      name: 'summary',
      type: 'textarea',
      maxLength: 300,
      admin: { description: 'Used for the page description in search results.' },
    },
    { name: 'body', type: 'richText', editor: lexicalEditor() },
  ],
};
