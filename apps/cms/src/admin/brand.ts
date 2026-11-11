// The CMS admin brand: the organisation name from ORGANISATION_NAME, else a neutral product title. Logo and palette are
// owner items (docs/GO-LIVE.md); the palette below is the current accessible one (white on #1f5a7a is 7.6:1, WCAG 2.2 AA).
const entered = (process.env['ORGANISATION_NAME'] ?? '').trim();
const name = entered === '' ? 'Website editor' : entered;

export const brand = {
  name,
  initial: name.charAt(0).toUpperCase(),
  primary: '#1f5a7a',
  onPrimary: '#ffffff',
} as const;
