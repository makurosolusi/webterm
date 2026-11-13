// Every string the first-run wizard shows (English, product language). Kept apart from the
// components so tests and later copy edits touch one file.
import type { SetupStep } from '../../shared/settings.setup'

export const SETUP_TEXT = {
  title: 'Set up webterm',
  stepOf: (n: number, total: number): string => `Step ${n} of ${total}`,
  steps: { claude: 'Claude', browser: 'Browser', central: 'Central Agent', basics: 'Basics' } as Record<SetupStep, string>,
  state: { done: 'Done', skipped: 'Skipped', current: 'Current', todo: 'Not started' },
  /** Codicon per answered/unanswered state; the wizard stepper and Welcome's card share it. */
  stateIcon: { done: 'pass-filled', skipped: 'circle-slash', todo: 'circle-large-outline' },
  progress: 'Setup progress',
  description: {
    claude: 'Choose how webterm signs in to Claude. Every Claude agent and Central use it.',
    browser: 'Browser nodes show live web pages on the canvas. Choose the browser they use.',
    central: 'Central is an assistant that sees all your projects and nodes.',
    basics: 'Theme, projects folder and notifications. Each one applies as you choose it.',
  } as Record<SetupStep, string>,
  back: 'Back',
  skip: 'Skip',
  next: 'Continue',
  finish: 'Finish',
  saving: 'Saving…',
  retry: 'Retry',
  retrying: 'Retrying…',
  saved: 'Saved',
  waitForLoad: 'Available once this step has loaded.',
  changeLater: (where: string): string => `You can change this later in Settings › ${where}.`,
  openSettings: 'Open in Settings',
  doneTitle: 'webterm is ready',
  complete: 'Setup complete',
  doneBody: 'Start with a project. Everything you chose here can be changed in Settings.',
  doneActions: { newProject: 'New project', openFolder: 'Open folder', clone: 'Clone repository' },
  close: 'Close',

  claude: {
    where: 'Claude › Connection',
    saveFailed: 'Could not save the Claude provider. Fix the error above, then Continue again.',
    untested: 'Not tested with a real request yet. You can continue and test it later.',
    failed: 'The connection test did not pass. You can continue and fix it later in Settings.'
  },

  browser: {
    where: 'Features › Browser on canvas',
    installed: 'Use installed browser',
    other: 'Use another path',
    off: "Don't use browser nodes",
    download: 'Download Chromium',
    pick: 'Browser to use',
    noneFound: 'No Chrome or Chromium was found on the server.',
    getChrome: 'Install Google Chrome',
    chromeUrl: 'https://www.google.com/chrome/',
    checkAgain: 'Check again',
    headless: 'Run hidden (headless)',
    headlessHint: 'Off: a real off-screen window, so sites treat it like a normal browser.',
    headlessLocked: 'Always on: this Linux server has no display, so the browser can only run hidden.',
    loading: 'Looking for a browser…',
    loadFailed: 'Could not load the browser settings.',
    saveFailed: 'Could not save the browser choice.',
    needPick: 'Pick a browser above first.',
    needPath: 'Enter the path of a browser above first.',
    needDownload: 'Wait for the download to finish first.',
    headlessLoading: 'Loading the current setting…',
    checking: 'Checking…',
    stillNone: 'Still no browser found.',
  },

  central: {
    where: 'Central › What Central may do',
    pick: 'How much Central may do',
    modes: {
      off: 'Off',
      central: 'Chat only',
      workers: 'Propose & run with approval',
      autonomy: 'Work on its own',
    },
    help: {
      off: 'No Central Agent. You can turn it on any time.',
      central: 'Talk to Central about your projects. It does not run anything.',
      workers: 'Central may propose commands and workers; each one waits for your approval.',
      autonomy: 'Central continues work on its own without asking at every step. Use only on a machine you trust it with.',
    },
    loading: 'Loading Central…',
    loadFailed: 'Could not load the Central Agent settings.',
    saveFailed: 'Could not save the Central choice.',
  },

  basics: {
    where: 'Appearance, Canvas and Notifications',
    theme: 'Theme',
    themes: { auto: 'System', light: 'Light', dark: 'Dark' },
    notify: 'Desktop notifications',
    notifyHint: 'Shown when an agent finishes or needs input while you are not looking.',
    telegram: 'Telegram',
    telegramLater: 'Connect later in Settings › Features',
    telemetry: 'webterm sends no telemetry.',
  },
}
