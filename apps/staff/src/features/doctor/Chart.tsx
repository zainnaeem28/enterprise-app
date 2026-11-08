import { useRef, useState } from 'react';
import {
  Banner,
  BreakTheGlassDialog,
  Button,
  EmergencyAccessBanner,
  LoadingState,
  PatientBanner,
  RangeText,
  StatusChip,
} from '@ehr/ui';
import type { AllergyData } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import { ageOf, dateTimeOf } from './format.js';
import type { Banner as BannerData, ChartEntry, ChartSummary } from './types.js';

export function allergyData(b: BannerData): AllergyData {
  if (b.allergies === null) return null;
  return {
    state: b.allergies.state,
    items: b.allergies.items.map((i) => ({
      id: i.id,
      name: i.name,
      ...(i.severity === undefined ? {} : { severity: i.severity }),
    })),
    moreCount: b.allergies.moreCount,
    uncodedCount: b.allergies.uncodedCount,
  };
}

/** The sticky banner (BR-34): name, date of birth and photo always; allergies per UI-UX 8, `null` is "not shown". */
export function BannerFor({
  banner,
  onOpenAllergies,
}: {
  banner: BannerData;
  onOpenAllergies?: () => void;
}) {
  return (
    <PatientBanner
      name={banner.displayName}
      dob={banner.dateOfBirth}
      age={ageOf(banner.dateOfBirth)}
      mrn={banner.mrn}
      {...(banner.photoUrl === undefined ? {} : { photoUrl: banner.photoUrl })}
      allergies={allergyData(banner)}
      {...(onOpenAllergies === undefined ? {} : { onOpenAllergies })}
    />
  );
}

function EntryList({
  title,
  items,
  id,
}: {
  title: string;
  items: ChartEntry[] | null;
  id: string;
}) {
  return (
    <section aria-labelledby={id} className="ehr-card">
      <h3 id={id} className="ehr-state__sub">
        {title}
      </h3>
      {items === null ? (
        <p className="ehr-muted">{d.notAvailable}</p>
      ) : items.length === 0 ? (
        <p className="ehr-muted">{d.noneListed}</p>
      ) : (
        <ul className="ehr-plain-list">
          {items.map((e) => (
            <li key={e.id}>
              {e.display}
              {e.detail !== null && <span className="ehr-muted"> · {e.detail}</span>}{' '}
              {!e.coded && <StatusChip tone="warning">{d.uncoded}</StatusChip>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * DR-03 chart summary. A chart read the doctor is not assigned to is refused (`403 clinical.not_assigned`, `btgAvailable`): the
 * break-the-glass dialog (DR-09) asks for a reason first, and nothing is requested until the reason has at least 10 characters.
 */
export function Chart({
  patientId,
  onBanner,
}: {
  patientId: string;
  onBanner?: (b: BannerData) => void;
}) {
  const { api, can } = useDoctor();
  const { state, reload } = useLoad(async () => {
    const r = await api.chartSummary(patientId);
    if (r.ok && onBanner !== undefined) onBanner(r.data.banner);
    return r;
  }, [patientId]);
  const [asking, setAsking] = useState(false);
  const [grant, setGrant] = useState<{ expiresAt: string } | null>(null);
  const [btgFailure, setBtgFailure] = useState<Failure | null>(null);
  const btgKey = useRef<string>(newKey());

  async function openBtg(reason: string) {
    setBtgFailure(null);
    const r = await api.breakGlass(patientId, reason, btgKey.current);
    setAsking(false);
    if (r.ok) {
      btgKey.current = newKey();
      setGrant({ expiresAt: r.data.expiresAt });
      reload();
    } else setBtgFailure(r);
  }

  if (state.kind === 'loading') return <LoadingState label={d.chartTitle} lines={6} />;

  if (state.kind === 'error') {
    const f = state.failure as Failure & { btgAvailable?: boolean };
    if (f.status === 403 && f.code === 'clinical.not_assigned') {
      const canBtg = f.btgAvailable === true && can('audit.btg.open');
      return (
        <section aria-labelledby="chart-title">
          <h2 id="chart-title">{d.chartTitle}</h2>
          <Banner tone="warning">
            <p>
              <strong>This patient is not assigned to you.</strong> You cannot open this chart
              unless you give a reason for emergency access.
            </p>
          </Banner>
          {btgFailure !== null && (
            <>
              <Banner tone="danger">
                <p>{d.btgFailed}</p>
              </Banner>
              <ActionError failure={btgFailure} />
            </>
          )}
          {canBtg && (
            <Button variant="primary" onClick={() => setAsking(true)}>
              Open with emergency access
            </Button>
          )}
          {asking && (
            <BreakTheGlassDialog
              onConfirm={(r) => void openBtg(r)}
              onCancel={() => setAsking(false)}
            />
          )}
        </section>
      );
    }
    return <LoadError failure={state.failure} onRetry={reload} />;
  }

  const c: ChartSummary = state.data;
  return (
    <section aria-labelledby="chart-title">
      <h2 id="chart-title" className="ehr-visually-hidden">
        {d.chartTitle}
      </h2>
      {grant !== null && (
        <>
          <EmergencyAccessBanner />
          <p className="ehr-muted">{d.btgEmergencyUntil(dateTimeOf(grant.expiresAt))}</p>
        </>
      )}
      <BannerFor banner={c.banner} />
      {c.level === 'previsit' && (
        <Banner tone="info">
          <p>{d.previsitOnly}</p>
        </Banner>
      )}
      <div className="ehr-doc-grid">
        <EntryList id="ch-problems" title={d.problems} items={c.problems} />
        <EntryList id="ch-meds" title={d.medications} items={c.medications} />
        <EntryList id="ch-allergies" title={d.allergies} items={c.allergies} />
        <section aria-labelledby="ch-vitals" className="ehr-card">
          <h3 id="ch-vitals" className="ehr-state__sub">
            {d.vitals}
          </h3>
          {c.vitals.length === 0 ? (
            <p className="ehr-muted">{d.noneListed}</p>
          ) : (
            <ul className="ehr-plain-list">
              {c.vitals.map((v) => (
                <li key={v.vitalId}>
                  {d.vitalName(v.loincCode)}:{' '}
                  <RangeText
                    status={v.enteredInError ? 'entered_in_error' : v.rangeStatus}
                    value={v.value === null ? '' : String(v.value)}
                    unit={v.unit ?? ''}
                    low={v.rangeLow}
                    high={v.rangeHigh}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="ehr-muted">
        {[
          c.encounterCount === null ? null : d.encounters(c.encounterCount),
          c.documentCount === null ? null : d.documents(c.documentCount),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </section>
  );
}
