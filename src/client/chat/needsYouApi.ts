// "Needs you" data for the Central chat hub: the unified inbox items (`GET /api/approvals/inbox`:
// gates, questions, reviews, updates) and the task projection (`GET /api/inbox`: blocked, review,
// broken tasks and ledger approvals with the APPROVE-phrase dialog). ONE shared poller in module
// scope feeds the strip, every approval card and the Dock badge, so mounting ten cards never means
// ten fetch loops. It only polls while something is subscribed and the tab is visible.
// Both endpoints are ledger routes: this works when Central itself is off.
import { useSyncExternalStore } from 'react'
import { APPROVAL_PATH, inboxErrorMessage, listInbox, type InboxItem } from '../inboxApi'
import { request } from '../inboxTransport'

export const INBOX_ITEMS_PATH = `${APPROVAL_PATH}/inbox`
export const NEEDS_YOU_POLL_MS = 2000
const HOUR_MS = 3_600_000
export const PERMISSION_KIND = 'agent.permission'

type UnifiedKind = 'notify' | 'question' | 'review' | 'gate'
export type ActionType = 'approve' | 'deny' | 'edit' | 'reply' | 'ignore' | 'snooze' | 'always'
export interface Impact { what: string; tier: string; rewindable: boolean }
export interface UnifiedItem {
  id: string
  kind: UnifiedKind
  source: string
  approvalKind: string | null
  /** The agent node the item is about, when it has one. */
  nodeId?: string | null
  title: string
  body: string | null
  impact: Impact | null
  args: unknown
  count: number
  actions: ActionType[]
}
/** `scope` only on approving a `model.fable` card: 'target' (this conversation/node) or 'project'. */
export type Action = { type: ActionType; args?: unknown; text?: string; until?: number; scope?: 'target' | 'project' }

/** Ledger approval kind of a Fable grant request (server models/fableGrant.ts). */
export const FABLE_KIND = 'model.fable'

/** A PR review draft (src/server/prreview) is approved by posting it, so its button says what happens. */
export const approveLabel = (item: Pick<UnifiedItem, 'kind' | 'source'>): string =>
  item.source === 'prreview' ? 'Post review' : item.kind === 'review' ? 'Accept' : 'Approve once'

export function impactText(impact: Impact): string {
  return `${impact.what} · ${impact.tier} · ${impact.rewindable ? 'rewindable from a checkpoint' : 'cannot be rewound'}`
}

/** Snooze presets: an hour, or tomorrow 09:00 local time. */
export function snoozeUntil(choice: '1h' | 'tomorrow', now: number): number {
  if (choice === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  return now + HOUR_MS
}

/** Ledger approvals other than Claude prompts keep the APPROVE-phrase dialog (projection row). */
const shownAsCard = (i: UnifiedItem): boolean =>
  !(i.kind === 'gate' && i.source === 'approval' && i.approvalKind !== PERMISSION_KIND && i.approvalKind !== FABLE_KIND)

export interface NeedsYouSnapshot {
  /** Every open unified item (cards look up any approvalId here, not just the strip's). */
  items: UnifiedItem[]
  tasks: InboxItem[]
  /** The unified list was read at least once; until then a missing card is "loading", not "expired". */
  itemsLoaded: boolean
  error: string | null
}

const EMPTY: NeedsYouSnapshot = { items: [], tasks: [], itemsLoaded: false, error: null }
let snap = EMPTY
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null
let again = false

function publish(next: NeedsYouSnapshot): void {
  snap = next
  for (const listener of listeners) listener()
}

// ponytail: first page only (server pages at 200 items); add paging if one person has more waiting.
async function load(): Promise<void> {
  const [items, tasks] = await Promise.allSettled([
    request<{ items?: UnifiedItem[] }>(INBOX_ITEMS_PATH),
    listInbox(),
  ])
  const failed = [items, tasks].find((r): r is PromiseRejectedResult => r.status === 'rejected')
  publish({
    items: items.status === 'fulfilled' ? items.value?.items ?? [] : snap.items,
    tasks: tasks.status === 'fulfilled' ? tasks.value : snap.tasks,
    itemsLoaded: snap.itemsLoaded || items.status === 'fulfilled',
    error: failed ? inboxErrorMessage(failed.reason) : null,
  })
}

/** Re-read both lists now. Calls during a read coalesce into one follow-up read. */
export function refreshNeedsYou(): Promise<void> {
  if (inFlight) {
    again = true
    return inFlight
  }
  inFlight = load().finally(() => {
    inFlight = null
    if (again) {
      again = false
      void refreshNeedsYou()
    }
  })
  return inFlight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    void refreshNeedsYou()
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refreshNeedsYou()
    }, NEEDS_YOU_POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useNeedsYou(): NeedsYouSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap)
}

/** What the strip lists: card items, and projection rows not already a card (no row twice). */
export function needsYouRows(s: NeedsYouSnapshot): { cards: UnifiedItem[]; tasks: InboxItem[] } {
  const cards = s.items.filter(shownAsCard)
  const carded = new Set(cards.map((c) => c.id))
  // Gates minted by producers (`gate_…`) are listed in both feeds; Claude prompts are `perm_…`.
  const tasks = s.tasks.filter((t) => !t.id.startsWith('perm_') && !carded.has(t.id))
  return { cards, tasks }
}

/** Items waiting for the operator, for the Dock badge. Shares the strip's poller. */
export function useNeedsYouCount(): number {
  const rows = needsYouRows(useNeedsYou())
  return rows.cards.length + rows.tasks.length
}

/** One answer on a unified item; the lists are re-read whatever happens. */
export async function actOnItem(id: string, action: Action): Promise<{ resolution?: string }> {
  try {
    return await request<{ resolution?: string }>(`${INBOX_ITEMS_PATH}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    })
  } finally {
    void refreshNeedsYou()
  }
}

/** test-only: forget the shared snapshot between tests. */
export function resetNeedsYou(): void {
  snap = EMPTY
  again = false
  inFlight = null
}
