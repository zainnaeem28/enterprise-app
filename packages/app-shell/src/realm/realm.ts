export type RealmKind = 'staff' | 'admin' | 'patient' | 'partner' | 'unknown';

// Exact values only. The contract names `google` (staff) and `admin_pool` (admin) as audiences (ARCH 26.2);
// `patient` and `partner` are assumed spellings pending the Architect. Anything else is `unknown` and is
// shown with a neutral label, never as staff.
const byValue: Record<string, RealmKind> = {
  google: 'staff',
  staff: 'staff',
  admin_pool: 'admin',
  admin: 'admin',
  patient: 'patient',
  partner: 'partner',
};

export function realmKind(session: { audience?: string; realm?: string } | undefined): RealmKind {
  for (const v of [session?.audience, session?.realm]) {
    const kind = v === undefined ? undefined : byValue[v.toLowerCase()];
    if (kind !== undefined) return kind;
  }
  return 'unknown';
}
