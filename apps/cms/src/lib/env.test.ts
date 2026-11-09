import { describe, expect, it } from 'vitest';
import { CmsConfigError, FORBIDDEN_PRODUCTION_VARS, loadCmsEnv } from './env';
import { goodEnv } from '../test-env';

describe('loadCmsEnv', () => {
  it('loads a complete marketing-account environment', () => {
    const e = loadCmsEnv(goodEnv);
    expect(e.publicUrl).toBe('https://cms.example.org');
    expect([...e.allowedEmails]).toEqual(['ann@example.org', 'bob@example.org']);
    expect(e.previewTtlSeconds).toBe(900);
  });

  it.each(FORBIDDEN_PRODUCTION_VARS)(
    'refuses to start when %s (production database access) is present',
    (name) => {
      expect(() => loadCmsEnv({ ...goodEnv, [name]: 'x' })).toThrow(
        /production database variables/,
      );
    },
  );

  it('ignores forbidden variables that are empty strings', () => {
    expect(() => loadCmsEnv({ ...goodEnv, DATABASE_URL: '' })).not.toThrow();
  });

  it('requires a dedicated CMS database role', () => {
    expect(() =>
      loadCmsEnv({ ...goodEnv, CMS_DATABASE_URL: 'postgres://app_rw:pw@h:5432/ehr' }),
    ).toThrow(/dedicated CMS database role/);
    expect(() => loadCmsEnv({ ...goodEnv, CMS_DATABASE_URL: 'mysql://cms_app:pw@h/cms' })).toThrow(
      /postgres/,
    );
    expect(() => loadCmsEnv({ ...goodEnv, CMS_DATABASE_URL: 'not a url' })).toThrow(CmsConfigError);
  });

  it.each([
    'PAYLOAD_SECRET',
    'CMS_PREVIEW_SECRET',
    'CMS_DATABASE_URL',
    'CMS_GOOGLE_CLIENT_ID',
    'CMS_GOOGLE_CLIENT_SECRET',
    'CMS_ALLOWED_EMAILS',
  ])('requires %s', (name) => {
    expect(() => loadCmsEnv({ ...goodEnv, [name]: undefined })).toThrow(new RegExp(name));
  });

  it('rejects short or identical secrets', () => {
    expect(() => loadCmsEnv({ ...goodEnv, PAYLOAD_SECRET: 'short' })).toThrow(/32 characters/);
    expect(() => loadCmsEnv({ ...goodEnv, CMS_PREVIEW_SECRET: goodEnv.PAYLOAD_SECRET })).toThrow(
      /differ/,
    );
  });

  it('requires https in production but allows localhost http in development', () => {
    expect(() => loadCmsEnv({ ...goodEnv, CMS_PUBLIC_URL: 'http://cms.example.org' })).toThrow(
      /https/,
    );
    expect(() =>
      loadCmsEnv({ ...goodEnv, CMS_PUBLIC_URL: 'http://localhost:3100', NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() => loadCmsEnv({ ...goodEnv, CMS_PUBLIC_URL: 'http://localhost:3100' })).toThrow(
      /https/,
    );
  });

  it('bounds the preview and session lifetimes', () => {
    expect(() => loadCmsEnv({ ...goodEnv, CMS_PREVIEW_TTL_SECONDS: '5' })).toThrow(/PREVIEW_TTL/);
    expect(() => loadCmsEnv({ ...goodEnv, CMS_SESSION_TTL_SECONDS: '999999' })).toThrow(
      /SESSION_TTL/,
    );
  });
});
