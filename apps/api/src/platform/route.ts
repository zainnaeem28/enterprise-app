// Route declaration (ARCHITECTURE 27.1, BD-07): every route declares {permission, resolver, elevation?, realm?}.
// A handler without a declaration is refused by the guard (deny by default) and fails the CI route inventory.
import { SetMetadata } from '@nestjs/common';

export const ROUTE_META = 'ehr:route';

export type Realm = 'google' | 'admin_pool' | 'patient' | 'partner' | 'none';

export interface RouteDeclaration {
  /** A catalogue permission (27.2), a patient-realm capability, or `public` for routes that need no session. */
  permission: string;
  /** Names how the resource's patient/location/organisation is found; `none` when the route has no resource. */
  resolver: string;
  elevation?: boolean;
  /** One realm, or the list of realms a route accepts (e.g. the alert routes: staff and admin). */
  realm?: Realm | readonly Realm[];
  /** Release-contract exemption (28.6). Closed list; decided from the route template, never from a header. */
  releaseExempt?: boolean;
  /** Request class for limits and rate limits (31.2, 31.3). Default: read for GET/HEAD, write otherwise. */
  routeClass?: 'read' | 'write' | 'stream' | 'health';
}

export const Route = (d: RouteDeclaration): MethodDecorator => SetMetadata(ROUTE_META, d);
