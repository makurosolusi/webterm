// Health tab labels, filter shape and small pure helpers.
import type { FindingOrigin, FindingStatus, FindingView, HealthLevel, HealthRule } from '../../../shared/centralHealth'

/** Findings list filter; `undefined` means "any". */
export interface FindingFilter { status: FindingStatus; severity?: HealthLevel; rule?: HealthRule; origin?: FindingOrigin }

export const DEFAULT_FILTER: FindingFilter = { status: 'open' }
/** How often the summary is re-read while a scan runs. */
export const SCAN_POLL_MS = 2_000
/** Server cap on a dismiss reason (`DISMISS_REASON_MAX`). */
export const DISMISS_REASON_MAX = 500
/** localStorage key of the remembered project. */
export const HEALTH_PROJECT_KEY = 'webterm.healthProject'
export const SCAN_RUNNING = 'scan_running'
export const ANALYSIS_RUNNING = 'analysis_running'
export const ANALYSIS_COOLDOWN = 'cooldown'
const PROJECT_NOT_FOUND = 'project_not_found'
/** Route not answering: Central is off (its routes fall through to a bare 404). */
const NOT_RUNNING = 'http_404'
/** A scan of a project without a folder ends `failed` with this in its error. */
const NO_REPO_ERROR = /no repository folder/i

export const STATUSES: FindingStatus[] = ['open', 'dismissed', 'fixed']
export const ORIGINS: FindingOrigin[] = ['scan', 'review', 'analysis']
export const LEVELS: HealthLevel[] = ['high', 'medium', 'low']
export const RULES: HealthRule[] = ['file_size', 'unreferenced_module', 'todo_no_context', 'empty_catch', 'new_file_no_test', 'analysis']

export const HL = {
  tab: 'Health',
  heading: 'Project health',
  intro: 'Problems Central found in the code, each with the evidence. Central only suggests; you decide.',
  about: 'About project health',
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
  summary: (open: number, when: string | null, files: number | null) =>
    [`${open} open`, when && `scanned ${when}`, files !== null && `${NUMBER.format(files)} files`].filter(Boolean).join(' · '),
  partial: 'Partial scan',
  partialHint: 'The scan hit its file or time limit; findings it did not reach are kept as they were.',
  severityFilter: (level: string, n: number | null) => (n === null ? level : `${level} ${NUMBER.format(n)}`),
  filtersLabel: 'Filter findings',
  filter: 'Filter',
  anyFilter: 'All sources and rules',
  statusLabel: 'Status',
  severityLabel: 'Severity',
  ruleLabel: 'Rule',
  empty: (when: string | null) => (when ? `No findings. Last scan ${when}.` : 'No findings.'),
  noMatch: 'No findings match these filters.',
  listLabel: 'Findings',
  loadMore: 'Load more',
  copy: 'Copy path',
  copied: 'Path copied',
  copyFailed: 'Could not copy the path.',
  openFile: 'Open file',
  cannotOpen: 'the project folder is not known here',
  askFix: 'Ask Central to fix',
  details: (title: string) => `Details for ${title}`,
  group: (label: string, n: number) => `${label} (${NUMBER.format(n)})`,
  rule: 'Rule',
  metrics: 'Metrics',
  actionsLabel: (title: string) => `Actions for ${title}`,
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
  originLabel: 'Found by',
  analyze: 'Deep analysis',
  analyzing: 'Analyzing…',
  analyzeCost: 'Deep analysis asks Claude to review the code; a run uses about $0.50 at most. Claims are kept only when their quote is found in the code.',
  analyzeFailed: 'Could not start the analysis.',
  analyzeAgain: (time: string) => `Available again at ${time}`,
  lastAnalysis: (when: string, opened: number) => `Last analysis ${when} · ${opened} new`,
  droppedClaims: (n: number) => `${n} unverified ${n === 1 ? 'claim' : 'claims'} dropped`,
  lastAnalysisFailed: (error: string | null) => `The last analysis failed${error ? `: ${error}` : '.'}`,
  verifiedQuote: 'Verified quote',
  verifiedQuoteHint: 'The quoted code was found at this line. The judgement is the model\u2019s: verify before acting.',
} as const

/** Viewer-locale number grouping ("13,360"). */
export const NUMBER = new Intl.NumberFormat()

export const STATUS_LABEL: Record<FindingStatus, string> = { open: 'Open', dismissed: 'Dismissed', fixed: 'Fixed' }
export const LEVEL_LABEL: Record<HealthLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' }
export const RULE_LABEL: Record<HealthRule, string> = {
  file_size: 'File too large', unreferenced_module: 'Unused module', todo_no_context: 'TODO without context',
  empty_catch: 'Empty catch', new_file_no_test: 'New file without test', analysis: 'Analysis',
}
export const ORIGIN_LABEL: Record<FindingOrigin, string> = { scan: 'Scan', review: 'Review', analysis: 'Analysis' }
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

/** A project of the picker; `root` is its folder when the board knows it (opens files). */
export interface HealthProject { id: string; name: string; root?: string }
export const SEVERITY_ICON: Record<HealthLevel, string> = { high: 'error', medium: 'warning', low: 'info' }
/** File name plus line, as a Problems row shows it. */
export const fileLabel = (f: Pick<FindingView, 'file' | 'line'>): string => {
  const base = f.file.slice(f.file.lastIndexOf('/') + 1)
  return f.line === null ? base : `${base}:${f.line}`
}
export const joinRoot = (root: string, file: string): string => `${root.replace(/\/+$/, '')}/${file}`
/** Size metrics arrive grouped with spaces ("20 000"); other evidence is quoted text and stays as it is. */
export const metricsOf = (f: Pick<FindingView, 'rule' | 'evidence'>): string =>
  f.rule === 'file_size' ? f.evidence.replace(/\d{1,3}(?: \d{3})+|\d+/g, (m) => NUMBER.format(Number(m.replace(/ /g, '')))) : f.evidence

/** Findings of one kind (same rule and title), in list order. */
export interface FindingGroup { key: string; title: string; items: FindingView[] }
export function groupFindings(items: FindingView[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>()
  for (const f of items) {
    const key = `${f.rule}\u0000${f.title}`
    const g = groups.get(key)
    if (g) g.items.push(f)
    else groups.set(key, { key, title: f.title, items: [f] })
  }
  return [...groups.values()]
}

/** The Central chat message "Ask Central to fix" prefills; the human reviews it before sending. */
export const fixRequest = (project: string, f: FindingView): string =>
  `Please fix this health finding in project ${project}: ${f.title} at ${locationOf(f)}. Evidence: ${f.evidence}. Suggestion: ${f.suggestion}`
