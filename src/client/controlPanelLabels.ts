// UI text of the Developer table and the Health/Spending/Rules/Developer sections (English product text, Rule 15).
export const CONTROL_TEXT = {
  intro: 'Every raw setting, its current value and where it comes from; a value set in the shell environment wins and is shown locked.',
  search: 'Filter settings',
  showAll: 'Show everything',
  showAllHint: 'Also show settings managed on other pages, derived from capability cards, or only set at startup.',
  loading: 'Loading effective configuration…',
  loadFailed: 'The effective configuration could not be loaded. Try again in a moment.',
  empty: 'No setting matches the filter.',
  mockBadge: 'MOCK',
  colKey: 'Setting',
  colValue: 'Effective',
  colSource: 'Source',
  colReason: 'Why',
  colUi: 'Control',
  noUi: 'Env-only',
  secretSet: 'set',
  secretUnset: 'unset',
  modifiedMark: 'Modified from the default',
  count: (shown: number, total: number): string => `${shown} of ${total} settings`,
  managedIn: (where: string): string => `Managed in ${where}`,
  locked: 'Locked',
  reset: 'Reset',
  resetTitle: 'Reset to the default (remove the Settings value)',
  save: 'Save',
  secretPlaceholder: 'New value (write-only)',
  notANumber: 'Enter a number.',
  saving: 'Saving…',
  resetting: 'Resetting…',
  saved: 'Saved.',
  secretEmpty: 'Type a new value first.',
  writeFailed: (why: string): string => `Not saved: ${why}`,
  restart: {
    none: 'Applies immediately.',
    hot: 'Applies to new sessions and on next use; running sessions keep the old value.',
    boot: 'Needs a restart of the webterm server.',
  } as Readonly<Record<string, string>>,
  restartPending: 'Saved; restart the webterm server to apply.',
} as const

/** Settings › Health: demo-mode banner and agent protection, above the Doctor. */
export const HEALTH_TEXT = {
  mock: 'Central is running in demo mode; replies are not real.',
  protectionTitle: 'Agent protection',
  protectionIntro: 'Whether agents run with their safety limits on this machine.',
  protectionLoading: 'Checking agent protection…',
  protectionMissing: 'Agent protection status is not available yet.',
  allProtected: 'Agents are protected',
  partly: (kind: string, why: string): string => `Partly protected — ${kind}${why ? `: ${why}` : ''}`,
  dataDir: 'Data folder',
  dataDirHint: 'Where webterm keeps its workspaces, settings and logs on this computer.',
  dataDirLoading: 'Finding the data folder…',
  copyPath: 'Copy path', copiedPath: 'Path copied', copyRefused: 'The browser did not allow copying.',
  developerTitle: 'Developer tools',
  developerMode: 'Show developer tools',
  developerModeHint: 'Adds the Developer page with every raw value, for troubleshooting. Also on with ?dev=1 in the address.',
} as const

/** Settings › Developer: the eval cases disclosure. */
export const DEVELOPER_TEXT = { evalCases: 'Show eval cases' } as const

/** Doctor (F1-f): health checks with one-click fixes, in Settings › Health. */
export const DOCTOR_TEXT = {
  title: 'Checks',
  intro: 'What webterm needs from this computer. A Fix button appears only where the fix is safe. For your code, see Health in the Control panel.',
  run: 'Check again',
  running: 'Checking…',
  notRun: 'The checks did not run.',
  summary: (total: number, attention: number): string =>
    (attention === 0 ? `All ${total} checks are fine.` : `${attention} of ${total} checks ${attention === 1 ? 'needs' : 'need'} attention.`),
  loadFailed: 'The checks could not be run.',
  fixing: 'Fixing…',
  fixFailed: 'The fix did not work; see the explanation.',
  fixed: (title: string): string => `Fixed: ${title} is OK now`,
  stillWrong: 'Fix applied, but the check still finds a problem; see the explanation.',
  open: (label: string): string => `Open ${label}`,
  copy: 'Copy diagnostics', copying: 'Copying…', copied: 'Diagnostics copied. Paste them into your report.',
  copyRefused: 'The browser did not allow copying.',
  copyNeedsChecks: 'Wait for the checks to finish first.',
  reportTitle: (at: string): string => `webterm diagnostics (${at})`,
  status: { ok: 'OK', warn: 'Warning', fail: 'Problem', off: 'Not in use' } as Readonly<Record<string, string>>,
} as const

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  default: 'Default',
  env: 'Shell env',
  '.env': '.env file',
  settings: 'Settings',
  capability: 'Capability card',
}
