export type RealmKind = 'staff' | 'admin' | 'patient' | 'partner' | 'unknown';

// `realm` and `audience` are the `GET /auth/session` fields. The kind comes from `realm` alone, by exact
// case-sensitive value (ARCH 26.1; `PrincipalRealm` and `AUDIENCE_OF` in apps/api/src/modules/identity/types.ts).
// `audience` is `staff` for both `google` and `admin_pool`, so it cannot tell them apart; it is only a
// consistency check. Anything else is `unknown`, shown with a neutral label, never as staff.
const byRealm: Record<string, { kind: RealmKind; audience: string }> = {
  google: { kind: 'staff', audience: 'staff' },
  admin_pool: { kind: 'admin', audience: 'staff' },
  patient_pool: { kind: 'patient', audience: 'patient' },
  partner_pool: { kind: 'partner', audience: 'partner' },
};

export function realmKind(session: { realm?: string; audience?: string } | undefined): RealmKind {
  const realm = session?.realm;
  if (realm === undefined || !Object.hasOwn(byRealm, realm)) return 'unknown';
  const entry = byRealm[realm]!;
  return session?.audience === entry.audience ? entry.kind : 'unknown';
}
