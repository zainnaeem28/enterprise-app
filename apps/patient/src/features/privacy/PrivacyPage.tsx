import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  Banner,
  Button,
  EmptyState,
  LoadingState,
  PermissionNote,
  RefreshingContent,
  StatusChip,
  TextAreaField,
} from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { newKey } from '../profile/lib/core.js';
import type { Failure } from '../profile/lib/core.js';
import { useSubmit } from '../profile/lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../profile/lib/hooks.js';
import { Problem } from '../profile/lib/Problem.js';
import type { PrivacyApi } from './api.js';
import type { PrivacyRequest, Status } from './types.js';

const MAX_DETAIL = 1000;

const KIND: Record<string, string> = {
  access: 'Access request',
  export: 'Copy of my data',
  correction: 'Correction request',
  deletion: 'Deletion request',
};

/** Status is text + icon + colour with what happens next (UX-R9). A deletion request never reads as "will be deleted" (D-8). */
export function statusOf(r: PrivacyRequest): { tone: Tone; label: string; next: string } {
  const s: Status = r.status;
  if (r.kind === 'deletion') {
    if (s === 'refused')
      return {
        tone: 'neutral',
        label: 'Closed',
        next: r.decisionReason ?? 'The privacy team closed this request. Nothing was deleted.',
      };
    return {
      tone: 'info',
      label: 'Recorded, waiting for a decision',
      next: 'The privacy team has it. Nothing has been deleted.',
    };
  }
  switch (s) {
    case 'received':
      return {
        tone: 'info',
        label: 'Received',
        next: 'The privacy team will check your identity first.',
      };
    case 'identity_verified':
      return {
        tone: 'info',
        label: 'Identity checked',
        next: 'The privacy team will now approve it.',
      };
    case 'in_progress':
      return {
        tone: 'warning',
        label: 'Being prepared',
        next: 'We are putting your data together. This can take a while.',
      };
    case 'fulfilled':
      return r.packageStatus === 'ready' || r.packageStatus === 'released'
        ? {
            tone: 'success',
            label: 'Ready to download',
            next: 'Download it below before the link time runs out.',
          }
        : r.packageStatus === 'expired'
          ? {
              tone: 'neutral',
              label: 'Download expired',
              next: 'The copy is no longer available. Ask for a new one.',
            }
          : { tone: 'success', label: 'Done', next: 'This request is complete.' };
    case 'refused':
      return {
        tone: 'neutral',
        label: 'Not done',
        next: r.decisionReason ?? 'The privacy team could not do this request.',
      };
    default:
      return { tone: 'info', label: 'Recorded', next: 'The privacy team has it.' };
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** PP-24: my privacy. Download my data, and a deletion request that is recorded without promising deletion (D-8). */
export function PrivacyPage({
  api,
  isOwn,
  open = (url) => window.location.assign(url),
}: {
  api: PrivacyApi;
  /** False for an account that only acts for others: privacy requests are the patient's own (D-7). */
  isOwn: boolean;
  /** Opens the short-lived download URL (injected in tests). */
  open?: (url: string) => void;
}) {
  const [items, setItems] = useState<PrivacyRequest[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState<'export' | 'deletion' | undefined>();
  const [detail, setDetail] = useState('');
  const [result, setResult] = useState<'export' | 'deletion' | undefined>();
  const [actionFailure, setActionFailure] = useState<Failure | undefined>();
  const [downloadNote, setDownloadNote] = useState<string | undefined>();
  const keys = useRef({ export: newKey(), deletion: newKey() });
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('My privacy');

  const load = useCallback(async () => {
    setRefreshing(true);
    const r = await api.list();
    setRefreshing(false);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setItems(r.data);
  }, [api]);
  useEffect(() => {
    if (isOwn) void load();
  }, [isOwn, load]);

  if (!isOwn)
    return (
      <section aria-labelledby="priv-h" className="ehr-card profile">
        <h1 id="priv-h" ref={heading} tabIndex={-1}>
          My privacy
        </h1>
        <PermissionNote scope="Appointments only" />
        <p>Privacy requests can only be made by the patient themselves.</p>
      </section>
    );

  async function ask(kind: 'export' | 'deletion') {
    await run(async () => {
      const text = detail.trim();
      const r = await api.create(kind, keys.current[kind], kind === 'deletion' ? text : undefined);
      setAsking(undefined);
      if (r.ok) {
        keys.current[kind] = newKey();
        setDetail('');
        setActionFailure(undefined);
        setResult(kind);
        return load();
      }
      setActionFailure(r);
    });
  }

  async function download(id: string) {
    setDownloadNote(undefined);
    const r = await api.downloadUrl(id);
    if (r.ok) return open(r.data.url);
    setDownloadNote(
      r.code === 'privacy.export_not_ready'
        ? 'Your copy is not ready yet. We will show it here when it is.'
        : r.status === 404
          ? 'We can not find this copy, or it is not available to you.'
          : 'We could not start the download. Try again.',
    );
  }

  return (
    <section aria-labelledby="priv-h" className="ehr-card profile">
      <h1 id="priv-h" ref={heading} tabIndex={-1}>
        My privacy
      </h1>

      {result === 'export' && (
        <Banner tone="info" title="Your request was recorded">
          The privacy team will check your identity, then prepare your data. Your request is listed
          below.
        </Banner>
      )}
      {result === 'deletion' && (
        <Banner tone="info" title="Your deletion request was recorded">
          Nothing has been deleted. The privacy team will look at your request and contact you.
        </Banner>
      )}
      {actionFailure !== undefined && (
        <Problem failure={actionFailure} onRetry={() => setActionFailure(undefined)} />
      )}
      {downloadNote !== undefined && <Banner tone="warning">{downloadNote}</Banner>}

      <h2>Download my data</h2>
      <p>
        Ask for a copy of the data we hold about you. We check your identity first. The copy is not
        sent by email: you download it here.
      </p>
      <p>
        <Button variant="primary" disabled={busy} onClick={() => setAsking('export')}>
          Request a copy of my data
        </Button>
      </p>

      <h2>Delete my account</h2>
      <p>
        You can ask for your account to be deleted. We record your request and send it to the
        privacy team. This does not delete anything today: health records are kept for as long as
        the law requires, and the clinic will tell you what can be removed.
      </p>
      <p>
        <Button disabled={busy} onClick={() => setAsking('deletion')}>
          Request account deletion
        </Button>
      </p>

      <h2>Your requests</h2>
      {failure !== undefined && items === undefined ? (
        <Problem failure={failure} onRetry={() => void load()} />
      ) : items === undefined ? (
        <LoadingState label="Loading your requests" lines={3} />
      ) : items.length === 0 ? (
        <EmptyState message="You have not made any privacy requests." />
      ) : (
        <RefreshingContent refreshing={refreshing}>
          <ul className="profile-list">
            {items.map((r) => {
              const st = statusOf(r);
              const ready =
                r.kind === 'export' &&
                r.status === 'fulfilled' &&
                (r.packageStatus === 'ready' || r.packageStatus === 'released');
              return (
                <li key={r.id} className="profile-item">
                  <p>
                    <strong>{KIND[r.kind]}</strong>, asked on {day(r.createdAt)}
                  </p>
                  <p>
                    <StatusChip tone={st.tone}>{st.label}</StatusChip>
                  </p>
                  <p className="profile-note">{st.next}</p>
                  {ready && <Button onClick={() => void download(r.id)}>Download my data</Button>}
                </li>
              );
            })}
          </ul>
        </RefreshingContent>
      )}

      {asking === 'export' && (
        <AlertDialog
          title="Request a copy of your data?"
          initialFocus="[data-cancel]"
          actions={
            <>
              <Button data-cancel onClick={() => setAsking(undefined)}>
                Not now
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void ask('export')}
              >
                Request my data
              </Button>
            </>
          }
        >
          <p>The privacy team will check your identity before they prepare anything.</p>
        </AlertDialog>
      )}
      {asking === 'deletion' && (
        <AlertDialog
          title="Record a deletion request?"
          initialFocus="[data-cancel]"
          actions={
            <>
              <Button data-cancel onClick={() => setAsking(undefined)}>
                Keep my account
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void ask('deletion')}
              >
                Record my deletion request
              </Button>
            </>
          }
        >
          <p>
            This records your request and sends it to the privacy team. It does not delete anything
            now. Health records are kept as the law requires.
          </p>
          <TextAreaField
            label="Anything you want the privacy team to know (optional)"
            hint="Please do not include health details."
            maxLength={MAX_DETAIL}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
          />
        </AlertDialog>
      )}
    </section>
  );
}
