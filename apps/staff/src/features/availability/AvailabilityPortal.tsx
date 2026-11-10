import { useMemo, useState } from 'react';
import { Banner, ErrorState, LoadingState, OfflineBanner, Tabs } from '@ehr/ui';
import type { ShellRuntime } from '@ehr/app-shell';
import { createAvailabilityApi } from './api.js';
import { AvailabilityContext } from './AvailabilityContext.js';
import { BlockedTimes } from './BlockedTimes.js';
import { CalendarLink } from './CalendarLink.js';
import type { Landing } from './CalendarLink.js';
import { Templates } from './Templates.js';
import { useDoctorSession } from '../doctor/session.js';
import { useOnline } from '../doctor/DoctorContext.js';
import { avStrings as s } from './strings.js';
import { AVAILABILITY_PATHS, isAvailabilityPath } from './paths.js';
import type { AvailabilityPath } from './paths.js';
import './availability.css';


type Section = 'hours' | 'leave' | 'calendar';

/** `?calendar=linked|denied|error` is what the Google callback adds to the return address (BE-14). Anything else is ignored. */
export function landingOf(search: string): Landing | null {
  const v = new URLSearchParams(search).get('calendar');
  return v === 'linked' || v === 'denied' || v === 'error' ? v : null;
}

/**
 * The doctor's availability (FE-11, DR-11..DR-13): weekly hours, leave and blocked time, Google Calendar connection. Permissions only
 * decide what is drawn; the server authorizes every call and the doctor can only ever act on their own principal.
 */
export function AvailabilityPortal({
  runtime,
  search = typeof window === 'undefined' ? '' : window.location.search,
  go = (url) => window.location.assign(url),
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  /** The query string of the page; read once for the calendar outcome word. */
  search?: string;
  /** Seam for tests: sends the browser to Google. */
  go?: (url: string) => void;
}) {
  const sessionLoad = useDoctorSession(runtime);
  const api = useMemo(() => createAvailabilityApi(runtime.api), [runtime.api]);
  const online = useOnline();
  const landing = useMemo(() => landingOf(search), [search]);
  const [section, setSection] = useState<Section>(landing === null ? 'hours' : 'calendar');

  if (sessionLoad.kind === 'loading') return <LoadingState label={s.title} lines={4} />;
  if (sessionLoad.kind === 'error')
    return <ErrorState kind="server" onRetry={() => window.location.reload()} />;
  const ready = sessionLoad.session;

  const ctx = {
    api,
    can: (p: string) => ready.permissions.includes(p),
    principalId: ready.principalId,
    online,
    go,
  };

  return (
    <AvailabilityContext.Provider value={ctx}>
      <h1>{s.title}</h1>
      {!online && <OfflineBanner />}
      <Tabs
        label={s.tabsLabel}
        selected={section}
        onSelect={(id) => setSection(id as Section)}
        items={[
          {
            id: 'hours',
            label: s.tabHours,
            panel:
              ready.locationIds.length === 0 ? (
                <Banner tone="info">
                  <p>{s.noLocation}</p>
                </Banner>
              ) : (
                <Templates locationIds={ready.locationIds} />
              ),
          },
          { id: 'leave', label: s.tabLeave, panel: <BlockedTimes /> },
          { id: 'calendar', label: s.tabCalendar, panel: <CalendarLink landing={landing} /> },
        ]}
      />
    </AvailabilityContext.Provider>
  );
}

export { AVAILABILITY_PATHS, isAvailabilityPath };
export type { AvailabilityPath };
