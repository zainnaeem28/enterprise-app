import { useCallback, useMemo, useState } from 'react';
import { Banner, LoadingState, OfflineBanner, SelectField, Tabs } from '@ehr/ui';
import type { TabItem } from '@ehr/ui';
import type { ShellRuntime } from '@ehr/app-shell';
import { createPreconsultApi } from './api.js';
import { DeskContext, selection, useOnline } from './DeskContext.js';
import { ArrivalsBoard } from './ArrivalsBoard.js';
import { CheckIn } from './CheckIn.js';
import { FollowUps, NoShows } from './FollowUps.js';
import { FormsReview } from './FormsReview.js';
import { Merge, DuplicateFlags } from './Merge.js';
import { Queue } from './Queue.js';
import { Registration } from './Registration.js';
import { Triage } from './Triage.js';
import { useDeskSession } from './session.js';
import { preStrings as p } from './strings.js';
import { ErrorState } from '@ehr/ui';
import { PRECONSULT_PATHS, isPreconsultPath } from './paths.js';
import type { PreconsultPath } from './paths.js';
import './preconsult.css';


/**
 * The pre-consultation desk (FE-09): arrivals, check-in, registration and duplicates, merge, forms review, triage, queue, follow-ups
 * and no-shows. Permissions only decide what is drawn; the server authorizes every call.
 */
export function PreconsultDesk({
  runtime,
  path,
  navigate,
  openChart,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  path: PreconsultPath;
  navigate: (path: string) => void;
  openChart?: (patientId: string) => void;
}) {
  const sessionLoad = useDeskSession(runtime);
  const api = useMemo(() => createPreconsultApi(runtime.api), [runtime.api]);
  const [chosen, setChosen] = useState<string | null>(null);

  if (sessionLoad.kind === 'loading') return <LoadingState label={p.desk} lines={4} />;
  if (sessionLoad.kind === 'error')
    return <ErrorState kind="server" onRetry={() => window.location.reload()} />;

  const { permissions, locationIds } = sessionLoad.session;
  if (locationIds.length === 0)
    return (
      <Banner tone="info">
        <p>{p.noLocation}</p>
      </Banner>
    );
  const locationId =
    chosen !== null && locationIds.includes(chosen) ? chosen : (locationIds[0] as string);

  return (
    <div>
      {locationIds.length > 1 && (
        <div className="ehr-desk-location">
          <SelectField
            label={p.location}
            hint={p.locationHint}
            value={locationId}
            onChange={(e) => {
              selection.set(null);
              setChosen(e.target.value);
            }}
          >
            {locationIds.map((id, i) => (
              <option key={id} value={id}>
                {p.locationN(i + 1)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <Screens
        key={locationId}
        path={path}
        api={api}
        locationId={locationId}
        permissions={permissions}
        navigate={navigate}
        {...(openChart === undefined ? {} : { openChart })}
      />
    </div>
  );
}

function Screens({
  path,
  api,
  locationId,
  permissions,
  navigate,
  openChart,
}: {
  path: PreconsultPath;
  api: ReturnType<typeof createPreconsultApi>;
  locationId: string;
  permissions: readonly string[];
  navigate: (path: string) => void;
  openChart?: (patientId: string) => void;
}) {
  const can = useCallback((perm: string) => permissions.includes(perm), [permissions]);
  const online = useOnline();
  const [tab, setTab] = useState<string | null>(null);
  const [mergePreset, setMergePreset] = useState<{ survivorId: string; mergedId: string } | null>(
    null,
  );

  const ctx = {
    api,
    locationId,
    navigate,
    can,
    online,
    showTab: setTab,
    ...(openChart === undefined ? {} : { openChart }),
  };

  const items = ((): TabItem[] => {
    const t = (id: string, label: string, panel: React.ReactNode): TabItem => ({
      id,
      label,
      panel,
    });
    switch (path) {
      case '/arrivals': {
        const out: TabItem[] = [];
        if (can('scheduling.check_in')) {
          out.push(
            t('arrivals', p.tabArrivals, <ArrivalsBoard />),
            t('checkin', p.tabCheckIn, <CheckIn />),
          );
        }
        if (can('patient.match') || can('patient.register'))
          out.push(t('register', p.tabRegister, <Registration />));
        if (can('patient.match'))
          out.push(
            t(
              'duplicates',
              p.tabDuplicates,
              <DuplicateFlags
                onMerge={(a, b) => {
                  setMergePreset({ survivorId: a, mergedId: b });
                  setTab('merge');
                }}
              />,
            ),
          );
        if (can('patient.merge.request') || can('patient.merge.approve'))
          out.push(t('merge', p.tabMerge, <Merge preset={mergePreset} />));
        return out;
      }
      case '/triage': {
        const out: TabItem[] = [];
        if (can('scheduling.queue.manage')) out.push(t('queue', p.tabQueue, <Queue />));
        if (
          can('clinical.vitals.record') ||
          can('clinical.triage.record') ||
          can('clinical.chart.read_previsit')
        )
          out.push(t('triage', p.tabTriage, <Triage />));
        return out;
      }
      case '/forms':
        return [t('forms', p.formsTitle, <FormsReview />)];
      case '/follow-ups': {
        const out: TabItem[] = [];
        if (can('clinical.referral.manage'))
          out.push(t('followups', p.tabFollowUps, <FollowUps />));
        if (can('scheduling.check_in') || can('clinical.referral.manage'))
          out.push(t('noshows', p.tabNoShows, <NoShows />));
        return out;
      }
    }
  })();

  if (items.length === 0) return <ErrorState kind="forbidden" homeHref="/" />;

  const initial =
    path === '/triage' && selection.get() !== null && items.some((i) => i.id === 'triage')
      ? 'triage'
      : (items[0] as TabItem).id;
  const selected = tab !== null && items.some((i) => i.id === tab) ? tab : initial;
  const current = items.find((i) => i.id === selected) as TabItem;

  return (
    <DeskContext.Provider value={ctx}>
      <h1>{p.desk}</h1>
      {!online && <OfflineBanner />}
      {items.length > 1 ? (
        <Tabs items={items} selected={selected} onSelect={setTab} label={p.desk} />
      ) : (
        current.panel
      )}
    </DeskContext.Provider>
  );
}

export { PRECONSULT_PATHS, isPreconsultPath };
export type { PreconsultPath };
