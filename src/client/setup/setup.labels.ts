// Every string the first-run wizard shows (English, product language). Kept apart from the
// components so tests and later copy edits touch one file.
import type { SetupStep } from '../../shared/settings.setup'

export const SETUP_TEXT = {
  title: 'Set up webterm',
  stepOf: (n: number, total: number): string => `Step ${n} of ${total}`,
  steps: { claude: 'Claude', browser: 'Browser', central: 'Central Agent', basics: 'Basics' } as Record<SetupStep, string>,
  state: { done: 'Done', skipped: 'Skipped', current: 'Current', todo: 'Not started' },
  back: 'Back',
  skip: 'Skip',
  next: 'Continue',
  finish: 'Finish',
  saving: 'Saving…',
  retry: 'Retry',
  changeLater: (where: string): string => `Change later in Settings › ${where}`,
  doneTitle: 'webterm is ready',
  doneBody: 'Start with a project. Everything you chose here can be changed in Settings.',
  doneActions: { newProject: 'New project', openFolder: 'Open folder', clone: 'Clone repository' },
  close: 'Close',

  claude: {
    intro: 'This applies to every Claude agent and Central.',
    where: 'Claude › Connection',
    saveFailed: 'Could not save the Claude provider. Fix the error above, then Continue again.',
  },

  browser: {
    where: 'Capabilities › Browser on canvas',
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
  },

  central: {
    where: 'Capabilities › Central Agent',
    intro: 'Central is an assistant that sees all your projects and nodes.',
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
    where: 'Appearance, Workspaces and Canvas',
    theme: 'Theme',
    themes: { auto: 'System', light: 'Light', dark: 'Dark' },
    notify: 'Desktop notifications',
    notifyHint: 'Shown when an agent finishes or needs input while you are not looking.',
    notifyBlocked: "Blocked by the browser. Allow notifications for this site in the browser's site settings.",
    notifyUnsupported: 'This browser does not support desktop notifications.',
    telegram: 'Telegram',
    telegramLater: 'Connect later in Settings › Capabilities',
    telemetry: 'webterm sends no telemetry.',
  },
}
