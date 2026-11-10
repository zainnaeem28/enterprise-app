export const goodEnv = {
  NODE_ENV: 'production',
  CMS_DATABASE_URL: 'postgres://cms_app:pw@cms-db.marketing.internal:5432/cms',
  PAYLOAD_SECRET: 'p'.repeat(40),
  CMS_PREVIEW_SECRET: 'v'.repeat(40),
  CMS_PUBLIC_URL: 'https://cms.example.org',
  CMS_SITE_PREVIEW_URL: 'https://www.example.org',
  CMS_GOOGLE_CLIENT_ID: 'cms-client.apps.googleusercontent.com',
  CMS_GOOGLE_CLIENT_SECRET: 'secret',
  CMS_GOOGLE_HOSTED_DOMAIN: 'example.org',
  CMS_ALLOWED_EMAILS: 'Ann@example.org, bob@example.org',
} as const;
