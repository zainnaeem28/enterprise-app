import { SLUG_RE } from '../admin/preview';

export const RESERVED_SLUGS = new Set([
  'preview',
  'api',
  'admin',
  'directory',
  'my',
  'staff',
  'sitemap.xml',
  'robots.txt',
]);

export function validateSlug(value: unknown): true | string {
  if (typeof value !== 'string' || value === '') return 'Slug is required';
  if (!SLUG_RE.test(value))
    return 'Use lower-case letters, digits and hyphens; "/" separates path parts';
  if (RESERVED_SLUGS.has(value.split('/')[0] ?? '')) return 'This path is used by the application';
  return true;
}
