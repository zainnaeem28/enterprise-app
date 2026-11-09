import type { CollectionConfig } from 'payload';
import { oauthEndpoints } from '../auth/endpoints';
import { sessionStrategy } from '../auth/session';

// CMS admins. There is no password: sign-in is Google Workspace SSO only, through the separate marketing OAuth client
// (auth/google.ts). Users are created on first successful sign-in; nobody can create or edit them through the API.
export const Users: CollectionConfig = {
  slug: 'users',
  labels: { singular: 'Editor', plural: 'Editors' },
  auth: {
    disableLocalStrategy: true,
    strategies: [sessionStrategy],
    removeTokenFromResponses: true, // the session cookie is HttpOnly; do not echo it into /me JSON
    cookies: { sameSite: 'Lax', secure: true },
  },
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'lastSignInAt'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: () => false,
    update: () => false,
    delete: () => false,
    admin: ({ req }) => Boolean(req.user),
  },
  endpoints: oauthEndpoints,
  fields: [
    // With the local strategy disabled Payload adds no e-mail column, so it is declared here.
    {
      name: 'email',
      type: 'email',
      required: true,
      unique: true,
      index: true,
      admin: { readOnly: true },
    },
    { name: 'googleSub', type: 'text', index: true, admin: { readOnly: true } },
    { name: 'lastSignInAt', type: 'date', admin: { readOnly: true } },
  ],
};
