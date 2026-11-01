/**
 * Shapes for the state-first inbox projection (RND/02-KEBUTUHAN.md U1).
 * The inbox is a read-only projection: it never writes, never approves, and
 * never acts. Every item carries the actionable id the UI would send back.
 */
import { LedgerError } from '../ledger/ledgerModel'

export type InboxCategory = 'needs_you' | 'review' | 'broken'
export type InboxKind = 'approval' | 'task' | 'lease'

/** Category order is the display order: human blockers first, then review, then failures. */
export const INBOX_CATEGORIES: readonly InboxCategory[] = ['needs_you', 'review', 'broken']

export const INBOX_CATEGORY_LABEL: Record<InboxCategory, string> = {
  needs_you: 'Needs you',
  review: 'Review',
  broken: 'Broken',
}

export interface InboxItem {
  /** Idempotency-safe actionable id: approval id, task id, or lease-holding task id. */
  id: string
  category: InboxCategory
  kind: InboxKind
  projectId: string | null
  projectName: string | null
  /** Human-readable one-liner derived from the spec/approval kind. */
  title: string
  /** Age in ms at projection time, clamped to >= 0. */
  ageMs: number
  createdAt: number
  /** Underlying row status (`pending`, `blocked`, `claimed_done`, `leased`, ...). */
  status: string
  /** Compact evidence/request summary; null when the row has none. */
  evidenceSummary: string | null
}

export interface InboxResult {
  items: InboxItem[]
  /** Total matching items across all pages (before limit/offset). */
  total: number
  limit: number
  offset: number
}

export interface InboxCounts {
  needsYou: number
  review: number
  broken: number
  total: number
}

export interface InboxOptions {
  /** Injected clock for deterministic stale-lease and age tests. Defaults to Date.now. */
  now?: number
  limit?: number
  offset?: number
}

export class InboxError extends LedgerError {}
