import { Banner, Button, EmptyState, LoadingState, PermissionNote, StatusChip } from '@ehr/ui';
import { useDesk, selection, useSelectedVisit } from './DeskContext.js';
import { LoadError } from './Problem.js';
import { PrevisitChips } from './VisitRows.js';
import { preStrings as p } from './strings.js';
import { nameOf, timeOf } from './format.js';
import { useLoad } from './useLoad.js';
import type { Arrival, ConsentRow, QuestionnaireRow } from './types.js';

/** PC-03: the three pre-visit items for one checked-in visit, each to do, done or needing a fix, in words. */
export function FormsReview() {
  const { api, locationId } = useDesk();
  const visit = useSelectedVisit();
  const list = useLoad(() => api.arrivals(locationId), [locationId], visit === null);

  if (visit === null) {
    if (list.state.kind === 'loading') return <LoadingState label={p.formsTitle} lines={3} />;
    if (list.state.kind === 'error')
      return <LoadError failure={list.state.failure} onRetry={list.reload} />;
    const checkedIn = list.state.data.filter((a) => a.checkedInAt !== null);
    return (
      <section aria-labelledby="forms-title">
        <h2 id="forms-title">{p.formsTitle}</h2>
        {checkedIn.length === 0 ? (
          <EmptyState message={p.arrivalsEmpty} />
        ) : (
          <>
            <p>{p.formsPick}</p>
            <ul className="ehr-plain-list">
              {checkedIn.map((a) => (
                <li key={a.reservationId} className="ehr-card">
                  <strong>{nameOf(a.patientName)}</strong>{' '}
                  <span className="ehr-muted">{timeOf(a.startsAt)}</span>{' '}
                  <Button onClick={() => selection.set(a)}>{p.openForms}</Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }
  return <VisitForms visit={visit} />;
}

function VisitForms({ visit }: { visit: Arrival }) {
  const { api } = useDesk();
  const consents = useLoad(() => api.consents(visit.patientId), [visit.patientId]);
  const answers = useLoad(() => api.questionnaires(visit.patientId), [visit.patientId]);
  const previsit = visit.previsit;

  return (
    <section aria-labelledby="forms-title">
      <div className="ehr-toolbar">
        <h2 id="forms-title">
          {p.formsTitle}: {nameOf(visit.patientName)}
        </h2>
        <Button onClick={() => selection.set(null)}>{p.formsPick}</Button>
      </div>
      <PrevisitChips previsit={previsit} />

      <h3>{p.questionnaire}</h3>
      <ItemStatus done={previsit?.questionnaire ?? false} />
      <Part state={answers.state} reload={answers.reload} scope="the pre-visit questionnaire">
        {(rows: QuestionnaireRow[]) => {
          const mine = rows.filter((r) => r.reservationId === visit.reservationId);
          if (mine.length === 0) return <p className="ehr-muted">{p.noQuestionnaire}</p>;
          return (
            <ul className="ehr-plain-list">
              {mine.map((r) => (
                <li key={r.id}>
                  <StatusChip tone={r.status === 'submitted' ? 'success' : 'warning'}>
                    {r.status === 'submitted' ? p.submitted : p.inProgress}
                  </StatusChip>{' '}
                  {r.redFlag && <StatusChip tone="danger">{p.redFlagOnForm}</StatusChip>}
                </li>
              ))}
            </ul>
          );
        }}
      </Part>

      <h3>{p.consents}</h3>
      <ItemStatus done={previsit?.consents ?? false} />
      <p className="ehr-muted">{p.consentGate}</p>
      <Part state={consents.state} reload={consents.reload} scope="consents">
        {(rows: ConsentRow[]) =>
          rows.length === 0 ? (
            <p className="ehr-muted">{p.noConsents}</p>
          ) : (
            <ul className="ehr-plain-list">
              {rows.map((c) => (
                <li key={c.id}>
                  {c.templateKey} v{c.templateVersion}{' '}
                  <StatusChip
                    tone={
                      c.status === 'signed'
                        ? 'success'
                        : c.status === 'withdrawn'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {c.status === 'signed'
                      ? p.signed
                      : c.status === 'pending'
                        ? p.pending
                        : c.status === 'superseded'
                          ? p.superseded
                          : p.withdrawn}
                  </StatusChip>
                </li>
              ))}
            </ul>
          )
        }
      </Part>

      <h3>{p.insurance}</h3>
      <ItemStatus done={previsit?.insurance ?? false} />
      <p className="ehr-muted">{p.insuranceNote}</p>
    </section>
  );
}

/** To do / Done in words; "needs fixing" comes from the item's own rows (a withdrawn consent), not from this flag. */
function ItemStatus({ done }: { done: boolean }) {
  return (
    <StatusChip tone={done ? 'success' : 'warning'}>
      {done ? p.statusDone : p.statusToDo}
    </StatusChip>
  );
}

function Part<T>({
  state,
  reload,
  scope,
  children,
}: {
  state: ReturnType<typeof useLoad<T>>['state'];
  reload: () => void;
  scope: string;
  children: (data: T) => React.ReactNode;
}) {
  if (state.kind === 'loading') return <LoadingState label={scope} lines={2} />;
  if (state.kind === 'error') {
    // A role without the read sees a note, not a blank that looks empty (UI-UX 6, permission-limited view).
    if (state.failure.status === 403) return <PermissionNote scope="pre-visit items" />;
    return (
      <Banner tone="warning">
        <p>{p.readFailedPart}</p>
        <Button onClick={reload}>Retry</Button>
      </Banner>
    );
  }
  return <>{children(state.data)}</>;
}
