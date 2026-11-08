import { Banner, Button, DataTable, LoadingState, RefreshingContent } from '@ehr/ui';
import type { Column } from '@ehr/ui';
import { useDesk, selection } from './DeskContext.js';
import { ActionError, LoadError } from './Problem.js';
import {
  CheckInButton,
  PrevisitChips,
  StatusCell,
  canCheckIn,
  patientCell,
  timeColumn,
  withLabels,
} from './VisitRows.js';
import { preStrings as p } from './strings.js';
import { timeOf } from './format.js';
import { useLoad } from './useLoad.js';
import { useVisitActions } from './useCheckIn.js';
import type { Arrival } from './types.js';

/** PC-01: today's visits at the location with pre-visit items, queue stage and the actions that make sense for each row. */
export function ArrivalsBoard() {
  const { api, locationId, can, navigate } = useDesk();
  const { state, reload } = useLoad(() => api.arrivals(locationId), [locationId]);
  const actions = useVisitActions(reload);
  const mayCheckIn = can('scheduling.check_in');

  if (state.kind === 'loading') return <LoadingState label={p.arrivalsTitle} lines={5} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;

  const open = (a: Arrival, path: string) => {
    selection.set(a);
    navigate(path);
  };

  const columns: Column<Arrival>[] = [
    timeColumn,
    { key: 'patient', header: p.colPatient, render: patientCell },
    { key: 'status', header: p.colStatus, render: (a) => <StatusCell a={a} /> },
    {
      key: 'previsit',
      header: p.colPrevisit,
      render: (a) => <PrevisitChips previsit={a.previsit} />,
    },
    {
      key: 'actions',
      header: p.colActions,
      render: (a) => (
        <span className="ehr-actions">
          {mayCheckIn && canCheckIn(a) && (
            <CheckInButton a={a} busy={actions.busy} onClick={(x) => void actions.checkIn(x)} />
          )}
          {mayCheckIn && a.noShowCandidate && a.status === 'confirmed' && (
            <Button disabled={actions.busy !== null} onClick={() => void actions.noShow(a)}>
              {p.markNoShow}
            </Button>
          )}
          {a.checkedInAt !== null && (
            <>
              <Button onClick={() => open(a, '/forms')}>{p.openForms}</Button>
              {can('scheduling.queue.manage') && (
                <Button onClick={() => open(a, '/triage')}>{p.openTriage}</Button>
              )}
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="arrivals-title">
      <div className="ehr-toolbar">
        <h2 id="arrivals-title">{p.arrivalsTitle}</h2>
        <span className="ehr-muted">{p.updatedAt(timeOf(state.updatedAt.toISOString()))}</span>
        <Button onClick={reload} disabled={state.refreshing}>
          {p.refresh}
        </Button>
      </div>
      {actions.notice !== null && (
        <Banner tone="info">
          <p>{actions.notice}</p>
        </Banner>
      )}
      {actions.failure !== null && <ActionError failure={actions.failure} />}
      {state.failure !== undefined && <ActionError failure={state.failure} />}
      <RefreshingContent refreshing={state.refreshing}>
        <DataTable
          caption={p.arrivalsTitle}
          columns={withLabels(columns)}
          rows={state.data}
          rowKey={(a) => a.reservationId}
          emptyMessage={p.arrivalsEmpty}
        />
      </RefreshingContent>
    </section>
  );
}
