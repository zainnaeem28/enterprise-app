// Sign-in and signed-out wording (UI-UX 3.1, 4 SH-03/SH-06, 7.1). Plain words; a proposal for the UI/UX reviewer,
// not a brand decision. No contact address or phone number is invented: the clinic's IT contact is a G2 setting
// that this ticket has not been given.
export const authStrings = {
  signInTitle: 'Sign in to the staff portal',
  signInLead: 'Use your clinic Google account.',
  continueWithGoogle: 'Continue with Google',
  notEnrolledTitle: 'Your account is not set up for this portal',
  notEnrolledBody:
    'If Google accepts your sign-in but the portal does not let you in, your account has not been enrolled yet. Contact IT.',
  problemTitle: 'We could not sign you in',
  problemBody:
    'Your account may not be set up for this portal, or the sign-in did not complete. Try again once. If it still does not work, contact IT.',
  signedOutTitle: 'You have signed out',
  signedOutBody: 'Your session is closed. Drafts you saved are kept.',
  signedOutAction: 'Sign in again',
  loadingSession: 'Checking your sign-in',
  adminSession:
    'This is an administrator sign-in. Staff screens are not available in this session.',
  noNavigation:
    'No staff screens are assigned to your account yet. If you expected some, contact IT.',
  notAvailableTitle: 'This screen is not available yet',
  notAvailableBody: 'It is part of the portal but has not been released.',
  primaryNav: 'Staff portal',
  more: 'More',
  moreNav: 'More screens',
  helpLink: 'Help',
} as const;
