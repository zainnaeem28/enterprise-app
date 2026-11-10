// `GET /public/v1/services|locations|clinicians` (ARCHITECTURE 29.5, 22.5.1, 21.3; SHARED-BOUNDARIES 5.1, 6.1).
// Every query runs under audience `public` with `app.org_id` from deployment configuration and nothing else, in a transaction forced
// read-only. `public` can read exactly the nine C0 views (T-DIRECTORY policies), so inactive services and locations, unlisted or
// disabled clinicians and ended templates are already absent at the database; the code below only intersects the view results and
// shapes the answer. Nothing here reads a base table.
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type {
  DirectoryOrganisationPort,
  DirectorySchedulingPort,
  PublicLocation,
  PublicService,
} from './ports.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicDirectoryDeps {
  db: KernelDb;
  /** The organisation of the deployment (21.3): never read from the request. */
  orgId: string;
  organisation: DirectoryOrganisationPort;
  scheduling: DirectorySchedulingPort;
}

export interface PublicClinician {
  clinicianId: string;
  displayName: string;
}

/** Fields of the public answers: a fixed allow-list, so a column added to a port record later cannot leak. */
const locationBody = (l: PublicLocation) => ({
  id: l.id,
  name: l.name,
  kind: l.kind,
  timeZone: l.timeZone,
  address: l.address,
  stateCode: l.stateCode,
  geo: l.geo,
  phone: l.phone,
});
const serviceBody = (s: PublicService) => ({
  id: s.id,
  patientDisplayName: s.patientDisplayName,
  durationMin: s.durationMin,
  mode: s.mode,
});

const invalid = (field: string): ApiError =>
  new ApiError(400, 'kernel.validation_failed', false, {
    errors: [{ path: `/${field}`, code: 'kernel.invalid_format' }],
  });

/** One optional UUID query value. A repeated parameter (an array) is refused. */
function uuidParam(query: Record<string, unknown>, name: string): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw invalid(name);
  return v.toLowerCase();
}

/** Unknown query parameters are refused on `integrations.` (CN-12): they would also split the CDN cache key. */
function onlyParams(query: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(query))
    if (!allowed.includes(k))
      throw new ApiError(400, 'kernel.validation_failed', false, {
        errors: [{ path: `/${k}`, code: 'kernel.unknown_field' }],
      });
}

export class PublicDirectoryService {
  constructor(private readonly d: PublicDirectoryDeps) {}

  private read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.d.db.withScope(
      { audience: 'public', orgId: this.d.orgId },
      async (tx) => {
        // PB-2: the route cannot write. Switching read-write to read-only is allowed after the scope settings were applied.
        await tx.query('SET LOCAL transaction_read_only = on');
        return fn(tx);
      },
      { idempotent: true },
    );
  }

  async locations(query: Record<string, unknown>) {
    onlyParams(query, []);
    const items = await this.read((tx) => this.d.organisation.directoryLocations(tx));
    return { items: items.map(locationBody), nextCursor: null };
  }

  /** Amendment A-8: current `site` banners from the view `public_banner`, exactly four fields each. */
  async banners(query: Record<string, unknown>) {
    onlyParams(query, []);
    const items = await this.read((tx) => this.d.organisation.directoryBanners(tx));
    return {
      items: items.map((b) => ({
        id: b.id,
        message: b.message,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      })),
      nextCursor: null,
    };
  }

  async services(query: Record<string, unknown>) {
    onlyParams(query, ['locationId']);
    const locationId = uuidParam(query, 'locationId');
    const items = await this.read((tx) =>
      this.d.organisation.directoryServices(tx, locationId === undefined ? {} : { locationId }),
    );
    return { items: items.map(serviceBody), nextCursor: null };
  }

  /**
   * Listed, active clinicians (`identity.public_clinician`) with an active template (at `locationId` when asked), eligible for
   * `serviceId` when asked, and, when both are asked, the service offered at that location. Anything else is absent, not an error:
   * an unknown, inactive or unlisted ID gives the same empty list, so the route is no oracle.
   */
  async clinicians(query: Record<string, unknown>): Promise<{ items: PublicClinician[] }> {
    onlyParams(query, ['serviceId', 'locationId']);
    const serviceId = uuidParam(query, 'serviceId');
    const locationId = uuidParam(query, 'locationId');
    return this.read(async (tx) => {
      if (serviceId !== undefined && locationId !== undefined) {
        const offered = await this.d.organisation.directoryServices(tx, { locationId });
        if (!offered.some((s) => s.id === serviceId)) return { items: [] };
      }
      const eligible =
        serviceId === undefined
          ? null
          : new Set(await this.d.organisation.directoryServiceClinicians(tx, serviceId));
      if (eligible !== null && eligible.size === 0) return { items: [] };
      const bookable = new Set(
        (await this.d.scheduling.directoryClinicianLocations(tx, locationId ?? null)).map(
          (p) => p.clinicianId,
        ),
      );
      if (bookable.size === 0) return { items: [] };
      const listed = await tx.query(
        `SELECT principal_id, display_name FROM identity.public_clinician ORDER BY display_name, principal_id`,
      );
      const items: PublicClinician[] = [];
      for (const r of listed.rows) {
        const id = String(r['principal_id']);
        if (!bookable.has(id) || (eligible !== null && !eligible.has(id))) continue;
        items.push({ clinicianId: id, displayName: String(r['display_name']) });
      }
      return { items };
    });
  }
}
