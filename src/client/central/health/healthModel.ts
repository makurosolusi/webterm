// Health tab labels, filter shape and small pure helpers.
import type { FindingStatus, FindingView, HealthLevel, HealthRule } from '../../../shared/centralHealth'

/** Findings list filter; `undefined` means "any". */
export interface FindingFilter { status: FindingStatus; severity?: HealthLevel; rule?: HealthRule }

export const DEFAULT_FILTER: FindingFilter = { status: 'open' }
/** How often the summary is re-read while a scan runs. */
export const SCAN_POLL_MS = 2_000
/** Server cap on a dismiss reason (`DISMISS_REASON_MAX`). */
export const DISMISS_REASON_MAX = 500
/** localStorage key of the remembered project. */
export const HEALTH_PROJECT_KEY = 'webterm.healthProject'
export const SCAN_RUNNING = 'scan_running'
const PROJECT_NOT_FOUND = 'project_not_found'
/** Route not answering: Central is off (its routes fall through to a bare 404). */
const NOT_RUNNING = 'http_404'
/** A scan of a project without a folder ends `failed` with this in its error. */
const NO_REPO_ERROR = /no repository folder/i

export const STATUSES: FindingStatus[] = ['open', 'dismissed', 'fixed']
export const LEVELS: HealthLevel[] = ['high', 'medium', 'low']
export const RULES: HealthRule[] = ['file_size', 'unreferenced_module', 'todo_no_context', 'empty_catch', 'new_file_no_test', 'analysis']

export const HL = {
  tab: 'Health',
  heading: 'Project health',
  intro: 'Problems Central found in the code, each with the evidence. Central only suggests; you decide.',
  project: 'Project',
  noProjects: 'No projects yet. Add a workspace for a folder to check its health.',
  loading: 'Loading…',
  loadFailed: 'Could not load project health.',
  findingsFailed: 'Could not load the findings.',
  retry: 'Retry',
  off: 'Central is off, so project health is not available.',
  openSettings: 'Open Central settings',
  noRepo: 'This project has no repository folder, so it cannot be scanned.',
  gone: 'This project no longer exists. Pick another one.',
  neverScanned: 'This project has not been scanned yet.',
  runScan: 'Run a scan',
  scanNow: 'Scan now',
  scanning: 'Scanning…',
  scanFailed: 'Could not start the scan.',
  lastScanFailed: (error: string | null) => `The last scan failed${error ? `: ${error}` : '.'}`,
  lastScan: (when: string, files: number) => `Last scan ${when} · ${files} files`,
  partial: 'Partial scan',
  partialHint: 'The scan hit its file or time limit; findings it did not reach are kept as they were.',
  counts: (open: number) => `${open} open`,
  countsLabel: 'Open findings by severity',
  filtersLabel: 'Filter findings',
  statusLabel: 'Status',
  severityLabel: 'Severity',
  ruleLabel: 'Rule',
  any: 'Any',
  allRules: 'All rules',
  empty: (when: string | null) => (when ? `No findings. Last scan ${when}.` : 'No findings.'),
  noMatch: 'No findings match these filters.',
  listLabel: 'Findings',
  loadMore: 'Load more',
  copy: (loc: string) => `Copy ${loc}`,
  copied: 'Copied',
  details: (title: string) => `Details for ${title}`,
  confidence: (c: HealthLevel) => `${LEVEL_LABEL[c]} confidence`,
  verifyFirst: 'verify first',
  suggestion: 'Suggestion',
  evidence: 'Evidence',
  source: 'Source',
  seen: (first: string, last: string) => `First seen ${first} · last seen ${last}`,
  dismissedBecause: (reason: string) => `Dismissed: ${reason}`,
  fixedAt: (when: string) => `Fixed ${when}`,
  dismiss: 'Dismiss',
  dismissLabel: (title: string) => `Dismiss ${title}`,
  dismissPrompt: 'Why is this not a problem? Central will not raise it again unless the evidence changes.',
  dismissNote: 'Note (optional)',
  dismissConfirm: 'Dismiss finding',
  cancel: 'Cancel',
  reopen: 'Reopen',
  reopenLabel: (title: string) => `Reopen ${title}`,
  actionFailed: 'That did not work. Try again.',
} as const

export const STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', dismissed: 'Dismissed', fixed: 'Fixed' }
export const LEVEL_LABEL: Record<HealthLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' }
export const RULE_LABEL: Record<HealthRule, string> = {
  file_size: 'File too large', unreferenced_module: 'Unused module', todo_no_context: 'TODO without context',
  empty_catch: 'Empty catch', new_file_no_test: 'New file without test', analysis: 'Analysis',
}
export const DISMISS_PRESETS = ['Intentional', 'False positive', 'Will fix later'] as const

/** `file:line`, or the file alone when the finding has no line. */
export const locationOf = (f: Pick<FindingView, 'file' | 'line'>): string => (f.line === null ? f.file : `${f.file}:${f.line}`)
/** Medium or low confidence: a human should check before acting. */
export const needsVerify = (c: HealthLevel): boolean => c !== 'high'
/** Reason sent to the server: the preset, then the note; clipped to the server cap. */
export const dismissReason = (preset: string | null, note: string): string =>
  [preset, note.trim()].filter(Boolean).join(': ').slice(0, DISMISS_REASON_MAX)
export const isGone = (code: string | null): boolean => code === PROJECT_NOT_FOUND
export const isNoRepoError = (error: string | null): boolean => error !== null && NO_REPO_ERROR.test(error)
export const isOff = (code: string | null): boolean => code !== null && (code.endsWith('_off') || code === NOT_RUNNING)
