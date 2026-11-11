import { AlertBar, AlertTray, Banner, LoadingState } from '@ehr/ui';
import type { AlertRow } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { LoadError, ActionError } from './Problem.js';
import { useBannerNames } from './alerts.js';
import type { useAlerts } from './alerts.js';
import { docStrings as d } from './strings.js';
import { timeOf } from './format.js';

export type AlertsModel = ReturnType<typeof useAlerts>;

/** The live-stream state as a bar that has no dismiss control: paused is never drawn as "no alerts" (UI-UX 7.4). */
export function StreamBar({ model }: { model: AlertsModel }) {
  if (model.streamState === 'paused')
    return <AlertBar state="paused" onReload={() => window.location.reload()} />;
  if (model.streamState === 'disconnected')
    return <AlertBar state="disconnected" onCheck={() => void model.reload()} />;
  return null;
}

/** A red flag is open for this doctor: a bar on every screen, no close control, leads to the tray. */
export function RedFlagStrip({ model, onOpen }: { model: AlertsModel; onOpen: () => void }) {
  const open = (model.items ?? []).filter(
    (a) =>
      a.type === 'red_flag' &&
      (a.status === 'open' || a.status === 'escalated') &&
      model.acks[a.alertId] === undefined &&
      !model.gone.includes(a.alertId),
  );
  if (open.length === 0) return null;
  return (
    <AlertBar state="raised">
      {d.redFlagOpen(open.length)}{' '}
      <button type="button" className="ehr-link-btn" onClick={onOpen}>
        {d.openTray}
      </button>
    </AlertBar>
  );
}

/** The alert tray (UI-UX 7.4): rows with the countdown rule, one-click acknowledge, paused-stream state. */
export function AlertsScreen({ model }: { model: AlertsModel }) {
  const { api } = useDoctor();
  const patientIds = [
    ...new Set((model.items ?? []).flatMap((a) => (a.patientId === null ? [] : [a.patientId]))),
  ];
  const banners = useBannerNames(api, patientIds);

  if (model.items === null)
    return model.failure !== null ? (
      <LoadError failure={model.failure} onRetry={() => void model.reload()} />
    ) : (
      <LoadingState label={d.alertsTitle} lines={3} />
    );

  const now = model.serverNow();
  const rows: AlertRow[] = model.items
    .filter((a) => a.status !== 'closed' && !model.gone.includes(a.alertId))
    .map((a) => {
      const ack = model.acks[a.alertId];
      const b = a.patientId === null ? undefined : banners[a.patientId];
      const row: AlertRow = {
        id: a.alertId,
        type: d.alertType(a.type),
        where: d.alertWhere(a.severity),
        ...(b === undefined || b === null ? {} : { patient: `${b.displayName}, ${b.dateOfBirth}` }),
        escalatesAtMs:
          now === null || a.escalatesAt === null || ack !== undefined
            ? null
            : Date.parse(a.escalatesAt),
        status: ack === undefined ? a.status : 'acknowledged',
        escalationLevel: a.escalationLevel,
      };
      if (ack !== undefined) {
        row.acknowledgedAt = timeOf(ack.acknowledgedAt);
        if (ack.alreadyAcknowledged) row.alreadyAcknowledged = true;
        if (a.acknowledgedByDisplayName !== null) row.acknowledgedBy = a.acknowledgedByDisplayName;
      } else if (a.status === 'acknowledged') {
        if (a.acknowledgedByDisplayName !== null) row.acknowledgedBy = a.acknowledgedByDisplayName;
        if (a.acknowledgedAt !== null) row.acknowledgedAt = timeOf(a.acknowledgedAt);
      }
      return row;
    });

  return (
    <section aria-labelledby="alerts-title">
      <h1 id="alerts-title">{d.alertsTitle}</h1>
      <StreamBar model={model} />
      {model.failure !== null && (
        <Banner tone="warning">
          <p>{d.alertsLoadFailed}</p>
        </Banner>
      )}
      {model.ackFailure !== null && model.ackFailure.code === 'notifications.alert_closed' ? (
        <Banner tone="info">
          <p>{d.alertClosedGone}</p>
        </Banner>
      ) : (
        model.ackFailure !== null && <ActionError failure={model.ackFailure} />
      )}
      <AlertTray
        alerts={rows}
        serverNow={() => model.serverNow() ?? Date.now()}
        onAcknowledge={(id) => void model.acknowledge(id)}
      />
    </section>
  );
}
