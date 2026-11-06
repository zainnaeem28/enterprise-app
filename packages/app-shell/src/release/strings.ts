// Release prompt wording (UI-UX 7.7). A proposal for reviewers there, not a brand decision.
export const releaseStrings = {
  barText: 'A new version is available. Finish or save what you are doing, then reload.',
  barUnsaved: 'This page has unsaved input.',
  reload: 'Reload',
  remindLater: 'Remind me later',
  confirmTitle: 'Reload and lose unsaved input?',
  confirmIntro: 'These forms have unsaved input:',
  stay: 'Stay on this page',
  reloadAnyway: 'Reload anyway',
  saveAndReload: 'Save draft and reload',
  saveFailed: 'The draft could not be saved, so the page was not reloaded.',
  blockedTitle: 'This page is out of date',
  blockedText:
    "This page is out of date and can't save changes. Reload to continue. Your last action did not go through, and you can repeat it after reload. Anything you typed on this page that was not saved will be lost.",
  requestIdLabel: 'Reference for support:',
  keepOpen: 'Keep this page open',
  keepOpenBar: 'This page is out of date. Saving is turned off. Reload to continue.',
  alertsPaused: 'Live alerts are paused because this page is out of date. Reload now.',
} as const;
