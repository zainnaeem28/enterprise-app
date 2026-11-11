// The statement to the patient after an account deletion (owner ruling 2026-11-11 C, item 1 (d)): what was deleted, what is kept, why and
// until when. Structured first (it is stored on the deletion record and compliance reads it), then rendered as plain text for the sender.
// It carries class names, counts, dates and reasons as codes: never a name, an identifier or a clinical value (no PHI). English text;
// translations are written by people (the same rule as the notification templates).

export const DELETED_CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  notification_preferences: 'your notification preferences',
  device_and_push_tokens: 'the devices and push-notification tokens registered to your account',
  marketing_and_cookie_consents: 'your marketing and cookie consents',
  drafts: 'forms you started but never submitted',
  unaccepted_uploads: 'files you uploaded that were never accepted into your record',
});

export const KEPT_CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  encounters: 'visits (encounters)',
  notes: 'clinical notes',
  note_addenda: 'note addenda',
  allergies: 'allergy entries',
  problems: 'problem list entries',
  medication_statements: 'medication entries',
  vital_signs: 'vital signs',
  triage_assessments: 'triage assessments',
  questionnaire_responses: 'submitted questionnaires',
  referrals: 'referrals',
  follow_ups: 'follow-ups',
  consents: 'signed treatment consents',
  accepted_documents: 'documents accepted into your record',
});

export interface ClassCount {
  class: string;
  count: number;
}

export interface DeletionStatement {
  version: 1;
  executedAt: string;
  accountDeactivated: true;
  deleted: ClassCount[];
  kept: ClassCount[];
  /** Why the medical record is kept: a code, not prose. */
  keptReason: 'medical_record_retention';
  /** The last day the medical record is kept; it is purged after that day. */
  keptUntil: string;
  /** Documents (all states) under a legal hold: never deleted. Their number only; the reason is not given. */
  legalHold: { documents: number };
  /** Uploads that would have been deleted but are under a legal hold. */
  keptByHold: ClassCount[];
  auditTrail: { kept: true; years: number };
}

export interface StatementInput {
  executedAt: Date;
  deleted: Record<string, number>;
  kept: Record<string, number>;
  keptByHold: Record<string, number>;
  heldDocuments: number;
  keptUntil: string;
  auditTrailYears: number;
}

const rows = (o: Record<string, number>, allowed: Readonly<Record<string, string>>): ClassCount[] =>
  Object.keys(allowed)
    .filter((k) => Number.isInteger(o[k]) && (o[k] as number) > 0)
    .map((k) => ({ class: k, count: o[k] as number }));

export function buildDeletionStatement(i: StatementInput): DeletionStatement {
  return {
    version: 1,
    executedAt: i.executedAt.toISOString(),
    accountDeactivated: true,
    deleted: rows(i.deleted, DELETED_CLASS_LABELS),
    kept: rows(i.kept, KEPT_CLASS_LABELS),
    keptReason: 'medical_record_retention',
    keptUntil: i.keptUntil,
    legalHold: { documents: i.heldDocuments },
    keptByHold: rows(i.keptByHold, DELETED_CLASS_LABELS),
    auditTrail: { kept: true, years: i.auditTrailYears },
  };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function renderStatementText(s: DeletionStatement): { subject: string; text: string } {
  const lines: string[] = [];
  lines.push('We have processed your request to delete your account.');
  lines.push('');
  lines.push(
    'Your account is now deactivated: you can no longer sign in and every session has been ended.',
  );
  lines.push('');
  lines.push('What we deleted:');
  if (s.deleted.length === 0) lines.push('- There was nothing in this category to delete.');
  for (const d of s.deleted)
    lines.push(`- ${DELETED_CLASS_LABELS[d.class] ?? d.class} (${d.count})`);
  lines.push('');
  lines.push('What we keep, and why:');
  lines.push(
    'The law requires us to keep your medical record. We keep the following until the end of ' +
      `${s.keptUntil}, after which it is destroyed:`,
  );
  if (s.kept.length === 0) lines.push('- No medical record entries are held.');
  for (const k of s.kept) lines.push(`- ${KEPT_CLASS_LABELS[k.class] ?? k.class} (${k.count})`);
  lines.push(
    `We also keep a record of who accessed your information (the audit trail) for ${s.auditTrail.years} years, as the law requires.`,
  );
  if (s.legalHold.documents > 0 || s.keptByHold.length > 0) {
    lines.push('');
    lines.push(
      `${s.legalHold.documents} ${plural(s.legalHold.documents, 'document is', 'documents are')} subject to a legal hold, ` +
        'so we are not allowed to delete ' +
        `${plural(s.legalHold.documents, 'it', 'them')} now. We cannot say more about the hold.`,
    );
    for (const k of s.keptByHold)
      lines.push(`- Kept because of the hold: ${DELETED_CLASS_LABELS[k.class] ?? k.class} (${k.count})`);
  }
  lines.push('');
  lines.push('If you have questions, contact the clinic and quote the date of this message.');
  return { subject: 'Your account deletion', text: lines.join('\n') };
}
