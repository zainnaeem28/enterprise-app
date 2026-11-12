// The CMS admin brand: the organisation name from ORGANISATION_NAME, else a neutral product title. Logo and palette are
// owner items (docs/GO-LIVE.md); the shared teal palette is used by the portal refresh.
const entered = (process.env['ORGANISATION_NAME'] ?? '').trim();
const name = entered === '' ? 'Website editor' : entered;

export const brand = {
  name,
  initial: name.charAt(0).toUpperCase(),
  primary: '#08746b',
  onPrimary: '#ffffff',
} as const;
