import { useMemo, useState } from 'react';
import { Banner, Button, ErrorState, LoadingState, OfflineBanner } from '@ehr/ui';
import type { ShellRuntime } from '@ehr/app-shell';
import { createDoctorApi } from './api.js';
import { DoctorContext, useOnline } from './DoctorContext.js';
import { Schedule } from './Schedule.js';
import { PatientList } from './PatientList.js';
import { Chart } from './Chart.js';
import { NoteEditor } from './NoteEditor.js';
import { NotesToSign } from './NotesToSign.js';
import { VideoNotes } from './VideoNotes.js';
import { AlertsScreen, RedFlagStrip, StreamBar } from './Alerts.js';
import { defaultStream, useAlerts } from './alerts.js';
import type { StreamFactory } from './alerts.js';
import { openReauthTab } from './SignFlow.js';
import { useDoctorSession } from './session.js';
import { docStrings as d } from './strings.js';
import { useKnownNotes, useOpen, workspace } from './workspace.js';
import type { Banner as BannerData } from './types.js';
import type { VideoAdapter } from './video.js';
import './doctor.css';

/** The paths this feature serves. They match the doctor navigation items and carry no record identifier. */
export const DOCTOR_PATHS = ['/schedule', '/patients', '/alerts', '/notes-to-sign'] as const;
export type DoctorPath = (typeof DOCTOR_PATHS)[number];
export const isDoctorPath = (path: string): path is DoctorPath =>
  (DOCTOR_PATHS as readonly string[]).includes(path);

/**
 * The doctor portal (FE-10): schedule, patient list, chart summary, note editor with sign, addenda, co-sign queue, alert tray and
 * the break-the-glass dialog. Permissions only decide what is drawn; the server authorizes every call.
 */
export function DoctorPortal({
  runtime,
  path,
  navigate,
  video,
  stream = defaultStream,
  renderDocuments,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  path: DoctorPath;
  navigate: (path: string) => void;
  /** The video adapter (DR-04). Absent until a vendor is chosen: the video pane then says so. */
  video?: VideoAdapter;
  /** Seam for tests: the live stream. */
  stream?: StreamFactory;
  /** Patient documents panel for the open chart, supplied by the app (documents feature). */
  renderDocuments?: (patientId: string, permissions: readonly string[]) => React.ReactNode;
}) {
  const sessionLoad = useDoctorSession(runtime);
  const api = useMemo(() => createDoctorApi(runtime.api), [runtime.api]);
  const online = useOnline();
  const ready = sessionLoad.kind === 'ready' ? sessionLoad.session : null;
  const canAlerts = ready?.permissions.includes('notifications.alert.read') === true;
  const alerts = useAlerts(api, runtime.api.clientRelease, canAlerts, stream);

  if (sessionLoad.kind === 'loading') return <LoadingState label={d.portal} lines={4} />;
  if (ready === null) return <ErrorState kind="server" onRetry={() => window.location.reload()} />;

  const ctx = {
    api,
    can: (p: string) => ready.permissions.includes(p),
    principalId: ready.principalId,
    roleKeys: ready.roleKeys,
    online,
    navigate,
    openReauth: () => openReauthTab(path),
    ...(video === undefined ? {} : { video }),
  };

  return (
    <DoctorContext.Provider value={ctx}>
      {!online && <OfflineBanner />}
      {canAlerts && path !== '/alerts' && (
        <>
          <StreamBar model={alerts} />
          <RedFlagStrip model={alerts} onOpen={() => navigate('/alerts')} />
        </>
      )}
      {path === '/schedule' &&
        (ready.locationIds.length === 0 ? (
          <Banner tone="info">
            <p>{d.noLocation}</p>
          </Banner>
        ) : (
          <Schedule locationIds={ready.locationIds} />
        ))}
      {path === '/patients' && (
        <Patients
          {...(renderDocuments === undefined
            ? {}
            : { documents: (id: string) => renderDocuments(id, ready.permissions) })}
        />
      )}
      {path === '/alerts' &&
        (canAlerts ? (
          <AlertsScreen model={alerts} />
        ) : (
          <ErrorState kind="forbidden" homeHref="/" />
        ))}
      {path === '/notes-to-sign' && <NotesToSign />}
    </DoctorContext.Provider>
  );
}

function Patients({ documents }: { documents?: (patientId: string) => React.ReactNode }) {
  const open = useOpen();
  const known = useKnownNotes();
  const [banner, setBanner] = useState<BannerData | null>(null);
  if (open === null) return <PatientList />;

  const patient =
    banner !== null && banner.patientId === open.patientId
      ? { id: banner.patientId, name: banner.displayName, dob: banner.dateOfBirth }
      : null;
  const resume = [...known]
    .reverse()
    .find((k) => k.note.patientId === open.patientId && k.note.status !== 'signed')?.note;
  const key = `${open.patientId}:${open.visit?.reservationId ?? ''}`;

  return (
    <section aria-labelledby="workspace-title">
      <h1 id="workspace-title" className="ehr-visually-hidden">
        {d.chartTitle}: {open.label}
      </h1>
      <div className="ehr-doc-back">
        <Button
          onClick={() => {
            setBanner(null);
            workspace.set(null);
          }}
        >
          {d.back}
        </Button>
      </div>
      <Chart key={key} patientId={open.patientId} onBanner={setBanner} />
      {documents !== undefined && (
        <section aria-label="Patient documents">{documents(open.patientId)}</section>
      )}
      {patient !== null &&
        (open.visit?.mode === 'video' ? (
          <VideoNotes
            key={key}
            visit={open.visit}
            patient={patient}
            {...(resume === undefined ? {} : { resume })}
          />
        ) : (
          <NoteEditor
            key={key}
            patient={patient}
            {...(open.visit === undefined ? {} : { visit: open.visit })}
            {...(resume === undefined ? {} : { resume })}
          />
        ))}
    </section>
  );
}
