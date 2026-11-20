// Teks bagian "Lanjutan" di tab Kemampuan (Rule 15). Tanpa nama env var dan tanpa istilah teknis internal.
export const ADVANCED_TEXT = {
  summary: 'Advanced',
  engineLabel: 'Engine',
  engineRuns: (version: string): string => (version ? `Runs on Claude · ${version}` : 'Runs on Claude'),
  engineCannotStart: (reason: string): string => `Claude cannot start: ${reason}`,
  engineCheckFailed: (cause: string): string => `Could not check Claude: ${cause}`,
  engineFirstCheck: 'Checking how Central starts Claude…',
  engineStamp: 'checked',
  engineCheckLabel: 'Check Claude',
  engineRecheck: 'Check again',
  engineChecking: 'Checking…',
  engineRecheckHint: 'Re-detect Claude and test how Central starts it (no tokens used)',
  chromiumLabel: 'Chromium location',
  chromiumPlaceholder: 'Path to the Chromium app',
  chromiumAuto: (path: string): string => `Automatic: ${path}`,
  chromiumUsingAuto: 'In use (automatic):',
  chromiumUsingOverride: 'In use (your choice):',
  chromiumOverrideInvalid: 'The location you chose was not found, so the browser can’t run. Fix it or use automatic.',
  chromiumMissing: 'Chromium was not found. Enter its location here.',
  chromiumUseAuto: 'Use automatic',
  chromiumRedetect: 'Detect again',
  detecting: 'Detecting…',
  saving: 'Saving…',
  reset: 'Reset capabilities',
  resetHint: 'Restores capability choices to their defaults. Your data is not deleted.',
  resetConfirm: 'Reset capabilities to their defaults?',
  resetting: 'Resetting…',
  resetDone: 'Capabilities are back to their defaults',
  changeFailed: 'The change did not go through. Try again in a moment.',
} as const

/** "Download Chromium" (wizard Browser step). */
export const DOWNLOAD_TEXT = {
  start: 'Download Chromium (~200 MB)',
  hint: 'A fixed Chrome for Testing build from Google, checked against a known checksum and saved in the webterm data folder. Nothing else on this computer changes.',
  checking: 'Checking the download…',
  progress: (percent: number): string => (percent > 0 ? `Downloading Chromium… ${percent}%` : 'Downloading Chromium…'),
  progressLabel: 'Chromium download',
  cancel: 'Cancel',
  cancelling: 'Cancelling…',
  retry: 'Try again',
  retrying: 'Starting again…',
  autoRetry: (attempt: number, max: number): string => `Connection problem. Trying again automatically (attempt ${attempt} of ${max})…`,
  starting: 'Starting…',
  done: 'Chromium is downloaded, verified and in use:',
  unreachable: 'Could not reach the webterm server. Try again.',
} as const

export const SECTION_TEXT = {
  loading: 'Loading capabilities…',
} as const
