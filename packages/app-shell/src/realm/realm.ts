export type RealmKind = 'staff' | 'admin' | 'patient' | 'partner' | 'unknown';

/** Staff realms are told apart by the session audience: `google` (staff) and `admin_pool` (admin) (ARCH 26.2). */
export function realmKind(session: { audience?: string; realm?: string } | undefined): RealmKind {
  const key = `${session?.audience ?? ''}|${session?.realm ?? ''}`.toLowerCase();
  if (key.includes('admin')) return 'admin';
  if (key.includes('google') || key.includes('staff')) return 'staff';
  if (key.includes('partner') || key.includes('pharmacy')) return 'partner';
  if (key.includes('patient') || key.includes('my')) return 'patient';
  return 'unknown';
}
