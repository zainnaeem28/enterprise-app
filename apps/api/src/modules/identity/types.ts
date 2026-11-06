import type { ScopeSettings } from '@ehr/kernel';

export type PrincipalRealm = 'patient_pool' | 'google' | 'admin_pool' | 'partner_pool';
export type SessionAudience = 'patient' | 'staff' | 'partner';

export const AUDIENCE_OF: Readonly<Record<PrincipalRealm, SessionAudience>> = {
  patient_pool: 'patient',
  google: 'staff',
  admin_pool: 'staff',
  partner_pool: 'partner',
};

export interface SessionRow {
  id: string;
  principalId: string;
  personId: string;
  realm: PrincipalRealm;
  audience: SessionAudience;
  authTime: Date;
  csrfHash: Buffer;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastInteractionAt: Date | null;
  revokedAt: Date | null;
}

export interface RoleGrant {
  key: string;
  privileged: boolean;
  /** Set exactly for location-bound roles. */
  locationId?: string;
}

interface Grant {
  all: boolean;
  locations: Set<string>;
  needsElevation: boolean;
}

/** The permissions a principal holds through its role assignments (27.1). Location-bound roles count only at their locations. */
export class PermissionGrants {
  private readonly byKey = new Map<string, Grant>();

  add(key: string, locationId: string | undefined, needsElevation: boolean): void {
    const g = this.byKey.get(key) ?? { all: false, locations: new Set<string>(), needsElevation };
    if (locationId === undefined) g.all = true;
    else g.locations.add(locationId);
    this.byKey.set(key, g);
  }

  /** With a location: held everywhere, or at that location. Without one: held at least somewhere. */
  has(key: string, locationId?: string): boolean {
    const g = this.byKey.get(key);
    if (g === undefined) return false;
    if (g.all) return true;
    return locationId !== undefined && g.locations.has(locationId);
  }

  needsElevation(key: string): boolean {
    return this.byKey.get(key)?.needsElevation ?? false;
  }

  keys(): string[] {
    return [...this.byKey.keys()].sort();
  }
}

export interface PatientAccess {
  patientId: string;
  relation: 'self' | 'proxy';
  /** `full` for the patient's own records, `appointments` for a proxy (D-7 default). */
  scope: 'full' | 'appointments';
  /** Given name and initial, so a proxy can tell linked patients apart (22.4). Proxy rows only. */
  displayName?: string;
}

/** Everything the guard and the handlers know about the caller after the session has been resolved. */
export interface AuthContext {
  session: SessionRow;
  scope: ScopeSettings;
  displayName: string;
  roles: RoleGrant[];
  grants: PermissionGrants;
  patients: PatientAccess[];
  /** The idle expiry after this request (touched or not), for the `X-Session-Idle-Expires-At` header. */
  idleExpiresAt: Date;
}
