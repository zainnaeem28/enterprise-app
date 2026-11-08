// Plain-language copy for the doctor portal (UI-UX 11). Safety-relevant wording (allergy block, range text, break-the-glass, sign,
// re-authentication, alert bar) comes from `@ehr/ui` so one reviewed string serves every screen.
export const docStrings = {
  portal: 'Doctor portal',
  noLocation:
    'Your account is not assigned to a location, so there is nothing to show. Ask an administrator.',
  location: 'Location',
  locationN: (n: number) => `Location ${n}`,
  updatedAt: (t: string) => `Updated at ${t}`,
  refresh: 'Refresh',

  // Schedule (DR-01)
  scheduleTitle: 'Schedule today',
  visitsHeading: 'Your visits',
  scheduleEmpty: 'You have no visits at this location today.',
  scheduleNoRead:
    'Your role cannot list the visits of a location. Open a patient from the Patients screen.',
  videoVisit: 'Video visit',
  inPerson: 'In person',
  openVisit: 'Open visit',
  statusLabel: (s: string) =>
    s === 'checked_in'
      ? 'Arrived'
      : s === 'in_consultation'
        ? 'In consultation'
        : s === 'completed'
          ? 'Completed'
          : s === 'no_show'
            ? 'No-show'
            : s === 'confirmed'
              ? 'Booked'
              : s,

  // Patient list (DR-02)
  patientsTitle: 'Patients',
  findPatient: 'Find a patient',
  findHint:
    'Search by name, date of birth (YYYY-MM-DD) or MRN. You see patients you are allowed to see.',
  searchName: 'Name',
  searchDob: 'Date of birth',
  searchMrn: 'MRN',
  search: 'Search',
  searching: 'Searching…',
  noResults: 'No patients match. Check the spelling or search with the MRN.',
  openChart: 'Open chart',
  colPatient: 'Patient',
  colDob: 'Date of birth',
  colMrn: 'MRN',
  dobBad: 'Enter the date of birth as YYYY-MM-DD.',
  needOne: 'Enter a name, a date of birth or an MRN.',
  back: 'Back to the list',

  // Chart (DR-03)
  chartTitle: 'Chart summary',
  problems: 'Problems',
  medications: 'Medicines',
  allergies: 'Allergies',
  vitals: 'Recent vitals',
  noneListed: 'Nothing listed.',
  notAvailable: 'Not available with your access.',
  uncoded: 'Uncoded: needs review',
  previsitOnly:
    'You can see the patient banner and recent vitals only. The rest of the chart is not available with your access.',
  encounters: (n: number) => `${n} earlier visit${n === 1 ? '' : 's'} on record`,
  documents: (n: number) => `${n} document${n === 1 ? '' : 's'} on record`,
  vitalName: (loinc: string) =>
    ({
      '8480-6': 'Systolic blood pressure',
      '8462-4': 'Diastolic blood pressure',
      '8867-4': 'Heart rate',
      '9279-1': 'Respiratory rate',
      '8310-5': 'Body temperature',
      '2708-6': 'Oxygen saturation',
      '29463-7': 'Body weight',
      '8302-2': 'Body height',
    })[loinc] ?? `Measurement ${loinc}`,
  chartLoadFailed: 'The chart could not be loaded.',

  // BTG (DR-09)
  btgEmergencyUntil: (t: string) => `Emergency access is open until ${t}.`,
  notAssignedTitle: 'This patient is not assigned to you.',
  notAssignedBody: 'You cannot open this chart unless you give a reason for emergency access.',
  btgOpenAction: 'Open with emergency access',
  patientFallback: 'Patient',
  btgFailed:
    'Emergency access could not be opened. Your reason was not recorded as a grant. Try again.',

  // Visit and note (DR-03, DR-05, DR-06)
  noteTitle: 'Visit note',
  startConsultation: 'Start consultation',
  starting: 'Starting…',
  consentsMissing: 'Telehealth consent not signed.',
  consentsMissingHelp:
    'Ask the front desk to send or record the consent. In an emergency you can start with an exception; the reason is recorded.',
  emergencyStart: 'Start with emergency exception',
  emergencyReason: 'Reason for the exception (required)',
  emergencyReasonNeeded: 'Enter a reason for the exception.',
  noVisitSelected:
    'Open a visit from your schedule to start a consultation and write a note for it.',
  noStartPermission: 'Your role cannot start a consultation.',
  noteSaving: 'Saving…',
  draftNotSaved: 'Draft not saved yet',
  signed: 'Note signed and locked',
  pendingCosign: 'Submitted for co-signature. The note is locked until your supervisor co-signs.',
  submitForCosign: 'Submit for co-signature',
  submitConsequence:
    'Submitting locks this note. Your supervisor reviews and co-signs it. Later changes are addenda with author and time.',
  saveFailed:
    'The draft could not be saved. Your text is still on this page. Try Save draft again.',
  signFailed: 'The note could not be signed. Your text is saved as a draft.',
  noteLocked: 'This note is already signed or submitted, so it can no longer be edited.',
  forbiddenSign:
    'You cannot sign this note. Only the clinician of the visit signs; an assistant prepares drafts.',
  supervisorMissing:
    'Your profile has no supervisor to co-sign, so the note cannot be submitted. Ask an administrator.',
  conflict:
    'Someone changed this note while you were editing. Refresh the chart and check before you try again.',
  reauthOpen: 'Sign in again (opens in a new tab)',
  reauthOpened:
    'Finish signing in in the other tab, then choose Sign now. Your draft stays on this page.',
  reauthRetry: 'Sign now',
  reauthRetrySubmit: 'Submit now',
  reauthCosignRetry: 'Co-sign now',
  addendumTitle: 'Addenda',
  addendumHint:
    'An addendum is added under the signed note with your name and the time. The note itself does not change.',
  addendumLabel: 'Addendum text',
  addendumSave: 'Add addendum to note',
  addendumNeeded: 'Enter the addendum text.',
  addendumNone: 'No addenda added in this session.',
  addendumBy: (t: string) => `Added at ${t}`,
  sectionLabel: (key: string) =>
    ({
      subjective: 'S: Subjective',
      objective: 'O: Objective',
      assessment: 'A: Assessment',
      plan: 'P: Plan',
    })[key] ?? key,

  // Notes to sign / co-sign (DR-07)
  notesTitle: 'Notes to sign',
  tabToSign: 'To sign',
  tabCosign: 'Co-sign queue',
  toSignEmpty: 'No draft notes are waiting in this session. Open a visit to write a note.',
  cosignEmpty: 'No notes are waiting for your co-signature in this session.',
  listGap:
    'This list shows notes opened in this browser session. A server list of notes to sign and to co-sign is not available yet.',
  open: 'Open',
  review: 'Review note',
  cosignAction: 'Co-sign note',
  cosignTitle: 'Co-sign this note',
  cosignConsequence:
    'Co-signing records your signature on the trainee’s locked note. It cannot be undone; later changes are addenda.',
  cosignDone: 'Note co-signed.',
  cosignNotSupervisor: 'Only the supervisor named on this note can co-sign it.',
  statusDraft: 'Draft',
  statusPending: 'Waiting for co-signature',
  statusSigned: 'Signed',

  // Alerts (DR alert tray)
  alertsTitle: 'Alerts',
  alertsLoadFailed: 'Alerts could not be loaded.',
  alertType: (t: string) =>
    ({
      red_flag: 'Red flag',
      note_unsigned: 'Note not signed',
      btg_opened: 'Emergency access opened',
      privileged_change: 'Privileged change',
      kill_switch_used: 'Access switched off',
      audit_anchor_mismatch: 'Audit check',
      scope_drift: 'Access scope changed',
      integration_down: 'Integration down',
    })[t] ?? 'Alert',
  alertWhere: (sev: string) =>
    ({
      critical: 'Critical',
      high: 'High priority',
      medium: 'Medium priority',
      low: 'Low priority',
    })[sev] ?? 'Alert',
  redFlagOpen: (n: number) =>
    `${n} red flag${n === 1 ? ' is' : 's are'} open. Open the alert tray.`,
  openTray: 'Open alerts',
  alertClosedGone: 'This alert is closed.',
  ackFailed: 'The alert could not be acknowledged. Try again.',

  // Video + notes (DR-04)
  videoTitle: 'Video visit',
  videoNotConnected:
    'Video is not connected in this environment. The video service has not been selected yet.',
  videoWaiting: 'Waiting to be admitted',
  videoNobody: 'Nobody is waiting.',
  admit: 'Admit',
  admitAll: 'Admit everyone',
  joinVideo: 'Join the call',
  leaveVideo: 'End the call',
  videoJoined: 'You are in the call.',
  videoFailed: 'The video call could not start. Your notes are not affected.',
  videoEnded: 'The call has ended.',
} as const;
