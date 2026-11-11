import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertDialog,
  Banner,
  Button,
  LoadingState,
  SelectField,
  StatusChip,
  TextField,
} from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { createDocumentsApi } from '../../../../../packages/app-shell/src/documents/index.js';
import type { DocumentRecord } from '../../../../../packages/app-shell/src/documents/index.js';
import type { ShellRuntime } from '@ehr/app-shell';
import { LoadError } from '../preconsult/Problem.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { useLoad } from '../preconsult/useLoad.js';
import { SCOPES, createGuardiansApi } from './api.js';
import type { Grant, GrantStatus, GuardianRelationship, Scope } from './api.js';

/** The document classes that can show a relationship (the server checks the same list). */
const RELATIONSHIP_CLASSES: readonly string[] = [
  'id_document',
  'consent',
  'external_record',
  'patient_upload_other',
];
const CLASS_LABEL: Record<string, string> = {
  id_document: 'ID document',
  consent: 'Consent form',
  external_record: 'Outside record',
  patient_upload_other: 'Other upload',
};
const STATUS: Record<GrantStatus, { tone: Tone; label: string }> = {
  invited: { tone: 'warning', label: 'Invited, not accepted yet' },
  requested: { tone: 'warning', label: 'Requested' },
  verified: { tone: 'info', label: 'Checked' },
  active: { tone: 'success', label: 'Active' },
  revoked: { tone: 'neutral', label: 'Revoked' },
  expired: { tone: 'neutral', label: 'Ended' },
};
const SCOPE_LABEL: Record<Scope, string> = {
  appointments: 'Appointments',
  messages: 'Messages',
  documents: 'Documents',
};
const REL_LABEL: Record<string, string> = {
  parent: 'Parent',
  guardian: 'Guardian',
  carer: 'Carer',
  other: 'Other',
};

export function failureLine(f: Failure): string {
  if (f.code === 'identity.proxy_not_allowed')
    return 'The link was not made. Guardian links are for patients under the age of majority, and need a checked document of this patient that can show the relationship.';
  if (f.code === 'identity.proxy_conflict')
    return 'This person already has an invitation or access for this patient.';
  if (f.status === 403) return "You don't have access to this.";
  if (f.status === 400 || f.status === 422)
    return 'Some details need changing. Check the fields above.';
  return 'Something went wrong on our side. Nothing was changed.';
}

const isUsable = (d: DocumentRecord) =>
  RELATIONSHIP_CLASSES.includes(d.classification) &&
  (d.status === 'clean' || d.status === 'confirmed');

/**
 * Staff: link a parent or guardian of a minor after checking the relationship document, see every proxy and invitation of the
 * patient, and revoke one at once. Permissions only decide what is drawn (`identity.proxy.verify`, `identity.proxy.revoke`);
 * the server authorizes every call. No e-mail address or document content is shown after it is sent.
 */
export function GuardianPanel({
  runtime,
  patientId,
  permissions,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  patientId: string;
  permissions: readonly string[];
}) {
  const api = useMemo(() => createGuardiansApi(runtime.api), [runtime.api]);
  const docs = useMemo(() => createDocumentsApi(runtime.api), [runtime.api]);
  const canLink = permissions.includes('identity.proxy.verify');
  const canRevoke = permissions.includes('identity.proxy.revoke');
  const grants = useLoad(() => api.grants(patientId), [api, patientId], canLink);
  const documents = useLoad(
    async () => {
      const r = await docs.list(patientId);
      return r.ok ? r : { ...r, fields: [] };
    },
    [docs, patientId],
    canLink,
  );

  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState<GuardianRelationship>('parent');
  const [documentId, setDocumentId] = useState('');
  const [picked, setPicked] = useState<Scope[]>(['appointments']);
  const [checked, setChecked] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [revoking, setRevoking] = useState<Grant | undefined>();
  const [revoked, setRevoked] = useState(false);
  const key = useRef(newKey());

  if (!canLink) return null;

  const usable = documents.state.kind === 'ready' ? documents.state.data.filter(isUsable) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254)
      found['guardian-email'] = "Guardian's email address: enter it like name@example.com.";
    if (documentId === '')
      found['guardian-doc'] = 'Relationship document: choose the document you checked.';
    if (!checked) found['guardian-checked'] = 'Confirm that you checked the document.';
    setErrors(found);
    setFailure(undefined);
    setDone(false);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    const r = await api.link(
      patientId,
      { email: trimmed, relationship, documentId, scopes: picked },
      key.current,
    );
    setBusy(false);
    if (r.ok) {
      key.current = newKey();
      setEmail('');
      setChecked(false);
      setDone(true);
      return grants.reload();
    }
    setFailure(r);
  }

  async function revoke() {
    if (revoking === undefined || busy) return;
    setBusy(true);
    const r = await api.revoke(patientId, revoking.id);
    setBusy(false);
    setRevoking(undefined);
    if (r.ok) {
      setRevoked(true);
      return grants.reload();
    }
    setFailure(r);
  }

  const list = grants.state.kind === 'ready' ? grants.state.data : undefined;
  return (
    <section aria-labelledby="guardian-h" className="ehr-guardians">
      <h2 id="guardian-h">Parents, guardians and proxies</h2>
      {done && (
        <Banner tone="info">
          The guardian was invited. They accept with the code sent to their email. Nothing is shared
          until they do.
        </Banner>
      )}
      {revoked && <Banner tone="info">Access was revoked. It ended at once.</Banner>}
      {failure !== undefined && (
        <Banner tone="danger">
          <p>{failureLine(failure)}</p>
          {failure.requestId !== undefined && (
            <p>
              Reference: <code>{failure.requestId}</code>
            </p>
          )}
        </Banner>
      )}

      {grants.state.kind === 'loading' && <LoadingState label="Loading proxies" lines={2} />}
      {grants.state.kind === 'error' && (
        <LoadError failure={grants.state.failure} onRetry={grants.reload} />
      )}
      {list !== undefined &&
        (list.length === 0 ? (
          <p>Nobody else has access to this patient.</p>
        ) : (
          <ul>
            {list.map((g) => (
              <li key={g.id}>
                <strong>{REL_LABEL[g.relationship] ?? 'Other'}</strong>{' '}
                <StatusChip tone={STATUS[g.status].tone}>{STATUS[g.status].label}</StatusChip>{' '}
                {g.guardian && <StatusChip tone="info">Guardian link</StatusChip>}
                <br />
                Granted: {g.scopes.map((s) => SCOPE_LABEL[s]).join(', ') || 'none'}. In force today:{' '}
                {g.effectiveScopes.map((s) => SCOPE_LABEL[s]).join(', ') || 'none'}.
                {g.inviteeHint !== undefined && <> Invited at {g.inviteeHint}.</>}
                {g.validUntil !== undefined && <> Ends on {g.validUntil}.</>}
                {canRevoke && g.status !== 'revoked' && g.status !== 'expired' && (
                  <>
                    {' '}
                    <Button onClick={() => setRevoking(g)}>Revoke</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ))}

      <h3>Link a parent or guardian</h3>
      <p>
        For a patient under the age of majority only. Check the document that shows the relationship
        first. The guardian gets an email with a code.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate aria-label="Link a parent or guardian">
        <TextField
          id="guardian-email"
          type="email"
          label="Guardian's email address"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors['guardian-email']}
        />
        <SelectField
          id="guardian-rel"
          label="Relationship"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as GuardianRelationship)}
        >
          <option value="parent">Parent</option>
          <option value="guardian">Guardian</option>
        </SelectField>
        <SelectField
          id="guardian-doc"
          label="Relationship document you checked"
          hint={
            documents.state.kind === 'ready' && usable.length === 0
              ? 'This patient has no checked document that can show a relationship. Upload one in Patient documents first.'
              : 'Only checked documents of this patient that can show a relationship are listed.'
          }
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          error={errors['guardian-doc']}
        >
          <option value="">Choose a document</option>
          {usable.map((d) => (
            <option key={d.id} value={d.id}>
              {CLASS_LABEL[d.classification] ?? 'Document'}, uploaded {d.uploadedAt.slice(0, 10)}
            </option>
          ))}
        </SelectField>
        <fieldset>
          <legend>What the guardian may see</legend>
          {SCOPES.map((sc) => (
            <p key={sc}>
              <label>
                <input
                  type="checkbox"
                  checked={sc === 'appointments' || picked.includes(sc)}
                  disabled={sc === 'appointments'}
                  onChange={(e) =>
                    setPicked((cur) =>
                      e.target.checked ? [...cur, sc] : cur.filter((x) => x !== sc),
                    )
                  }
                />{' '}
                {SCOPE_LABEL[sc]}
              </label>
            </p>
          ))}
          <p>From the age set by the clinic, the guardian keeps appointments only.</p>
        </fieldset>
        <p>
          <label>
            <input
              id="guardian-checked"
              type="checkbox"
              checked={checked}
              aria-invalid={errors['guardian-checked'] !== undefined}
              onChange={(e) => setChecked(e.target.checked)}
            />{' '}
            I checked that this document shows the relationship.
          </label>
          {errors['guardian-checked'] !== undefined && (
            <span role="alert"> {errors['guardian-checked']}</span>
          )}
        </p>
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          Send invitation
        </Button>
      </form>

      {revoking !== undefined && (
        <AlertDialog
          title="Revoke this access?"
          initialFocus="[data-keep]"
          actions={
            <>
              <Button data-keep onClick={() => setRevoking(undefined)}>
                Keep access
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void revoke()}
              >
                Revoke now
              </Button>
            </>
          }
        >
          <p>
            This person stops seeing the patient straight away. It is recorded in the audit log.
          </p>
        </AlertDialog>
      )}
    </section>
  );
}
