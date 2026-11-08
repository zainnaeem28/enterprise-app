import { Button, StatusChip } from '@ehr/ui';
import type { ReactNode } from 'react';
import type { Column } from '@ehr/ui';
import { preStrings as p } from './strings.js';
import { nameOf, timeOf } from './format.js';
import type { Arrival, Previsit } from './types.js';

const CHIP: Record<keyof Previsit, string> = {
  questionnaire: p.previsitQuestionnaire,
  consents: p.previsitConsents,
  insurance: p.previsitInsurance,
};

/** Three pre-visit items, each done or to do in words (AC-09). `null` is "not known": a visit that is not checked in yet. */
export function PrevisitChips({ previsit }: { previsit: Previsit | null }) {
  return (
    <span className="ehr-chip-row">
      {(Object.keys(CHIP) as (keyof Previsit)[]).map((k) => (
        <StatusChip
          key={k}
          tone={previsit === null ? 'neutral' : previsit[k] ? 'success' : 'warning'}
        >
          {CHIP[k]}:{' '}
          {previsit === null ? p.previsitUnknown : previsit[k] ? p.previsitDone : p.previsitTodo}
        </StatusChip>
      ))}
    </span>
  );
}

export function StatusCell({ a }: { a: Arrival }) {
  if (a.status === 'no_show') return <StatusChip tone="danger">{p.statusNoShow}</StatusChip>;
  if (a.status === 'completed') return <StatusChip tone="neutral">{p.statusCompleted}</StatusChip>;
  if (a.status === 'in_consultation')
    return <StatusChip tone="info">{p.statusInConsultation}</StatusChip>;
  if (a.checkedInAt !== null)
    return (
      <StatusChip tone="success">
        {p.checkedInVia(a.method === 'qr' ? p.methodQr : p.methodDesk)}
      </StatusChip>
    );
  return (
    <>
      <StatusChip tone="neutral">{p.notCheckedIn}</StatusChip>
      {a.noShowCandidate && <StatusChip tone="warning">{p.noShowCandidate}</StatusChip>}
      {a.flaggedForStaff && <StatusChip tone="warning">{p.flaggedForStaff}</StatusChip>}
    </>
  );
}

export const canCheckIn = (a: Arrival): boolean =>
  a.status === 'confirmed' && a.checkedInAt === null && a.mode === 'in_person';

export function patientCell(a: Arrival) {
  return (
    <>
      <strong>{nameOf(a.patientName)}</strong>
      {a.mrn !== null && <span className="ehr-muted"> · {a.mrn}</span>}
      {a.mode === 'video' && <span className="ehr-muted"> · {p.video}</span>}
    </>
  );
}

export const timeColumn: Column<Arrival> = {
  key: 'time',
  header: p.colTime,
  render: (a) => timeOf(a.startsAt),
};

export function CheckInButton({
  a,
  busy,
  onClick,
}: {
  a: Arrival;
  busy: string | null;
  onClick: (a: Arrival) => void;
}) {
  return (
    <Button
      variant="primary"
      disabled={busy !== null}
      aria-label={`${p.checkInAction}: ${nameOf(a.patientName)}`}
      onClick={() => onClick(a)}
    >
      {busy === a.reservationId ? p.checkingIn : p.checkInAction}
    </Button>
  );
}

/**
 * On a phone each table row becomes a card (UI-UX 9): every cell carries its column name as `data-label`, and `preconsult.css` shows
 * it above the value at that width. From 600 px the label is hidden and the table reads as a table.
 */
export function withLabels<T>(columns: Column<T>[]): Column<T>[] {
  return columns.map((c) => ({
    ...c,
    render: (row: T): ReactNode =>
      c.key === 'actions' ? (
        c.render(row)
      ) : (
        <span className="ehr-desk-cell" data-label={c.header}>
          {c.render(row)}
        </span>
      ),
  }));
}
