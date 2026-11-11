/** Central health findings: shared shapes between the scanners, the store and the UI. */

export type HealthRule =
  | 'file_size'
  | 'unreferenced_module'
  | 'todo_no_context'
  | 'empty_catch'
  | 'new_file_no_test'
  | 'analysis'
export type HealthLevel = 'high' | 'medium' | 'low'
export type FindingStatus = 'open' | 'fixed' | 'dismissed'
export type FindingOrigin = 'scan' | 'review' | 'analysis'

/** A finding as produced by a scanner, before it is stored. */
export interface FindingDraft {
  rule: HealthRule
  severity: HealthLevel
  confidence: HealthLevel
  file: string
  line: number | null
  title: string
  evidence: string
  source: string
  suggestion: string
  fingerprint: string
}

/** A stored finding with its lifecycle state. */
export interface FindingView extends FindingDraft {
  id: string
  projectId: string
  origin: FindingOrigin
  status: FindingStatus
  taskId: string | null
  dismissedReason: string | null
  dismissedBy: string | null
  firstSeenAt: number
  lastSeenAt: number
  fixedAt: number | null
}

/** One scan run and its outcome counts. */
export interface HealthScanView {
  id: string
  projectId: string
  origin: FindingOrigin
  status: 'running' | 'done' | 'failed'
  startedAt: number
  finishedAt: number | null
  filesScanned: number
  truncated: boolean
  opened: number
  fixed: number
  error: string | null
}

/** Per-project open-finding counts plus the latest scan. */
export interface HealthSummary {
  open: number
  high: number
  medium: number
  low: number
  lastScan: HealthScanView | null
}
