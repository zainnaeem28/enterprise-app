// Session and realm wording (UI-UX 3.1, 7.1). A proposal for reviewers there, not a brand decision.
export const sessionStrings = {
  extendFailed: 'Your session could not be extended. Try again, or sign out.',
  signOutBlockedTitle: 'Your draft could not be saved',
  signOutBlockedBody:
    'Your unsaved work could not be saved to the server, so you have not been signed out.',
  signOutAnyway: 'Sign out anyway',
  stayHere: 'Stay signed in',
  unsavedLostNote: (names: string) => `Not saved and lost on sign-out: ${names}.`,
  adminBanner: 'Administrator sign-in. Clinical data is not available here.',
  switchToAdmin: 'Sign out to switch to administrator',
  switchToStaff: 'Sign out to switch to staff',
  switchDraftNote: 'Unsaved work is kept as a draft where the screen supports drafts.',
  signOut: 'Sign out',
  staffPortal: 'Staff portal',
  adminPortal: 'Administrator portal',
  patientPortal: 'Patient portal',
  partnerPortal: 'Pharmacy portal',
} as const;
