// "Needs you": the one combined read behind the Central strip and Telegram `/inbox`. Two sources,
// grouped the same way on every surface:
//   - open `inbox_item` rows (the unified items list, after its pull-syncs): gates/questions ->
//     Approvals, review/notify -> Review;
//   - the `buildInbox` task projection: blocked tasks -> Approvals, claimed_done/suspect -> Review,
//     failed/cancelled/expired lease -> Broken. Its approval rows are skipped: `syncApprovalGates`
//     already mirrors every pending approval as a gate item, so they would be counted twice.
import type { Database } from 'bun:sqlite'
import { buildInbox } from './inbox'
import { listInboxItems } from './inboxItemStore'

export type NeedsYouGroupName = 'Approvals' | 'Review' | 'Broken'

export interface NeedsYouEntry {
  id: string
  title: string
  projectId: string | null
}

export interface NeedsYouGroup {
  name: NeedsYouGroupName
  count: number
  /** Items-list rows first, then task rows; each source oldest first. */
  items: NeedsYouEntry[]
}

/** Group order is display order: consent first, then verdicts, then failures. */
const ORDER: readonly NeedsYouGroupName[] = ['Approvals', 'Review', 'Broken']

// ponytail: counts cover each source's first page (100 rows); page further if a board ever holds more.
const PAGE = 100

export function readNeedsYou(db: Database, now: () => number = Date.now): NeedsYouGroup[] {
  const groups = new Map<NeedsYouGroupName, NeedsYouEntry[]>(ORDER.map((name) => [name, []]))
  for (const item of listInboxItems({ db, now }, { limit: PAGE })) {
    const name = item.kind === 'gate' || item.kind === 'question' ? 'Approvals' : 'Review'
    groups.get(name)?.push({ id: item.id, title: item.title, projectId: item.projectId })
  }
  for (const item of buildInbox(db, undefined, { now: now(), limit: PAGE }).items) {
    if (item.kind === 'approval') continue
    const name = item.category === 'needs_you' ? 'Approvals' : item.category === 'review' ? 'Review' : 'Broken'
    groups.get(name)?.push({ id: item.id, title: item.title, projectId: item.projectId })
  }
  return ORDER.map((name) => {
    const items = groups.get(name) ?? []
    return { name, count: items.length, items }
  })
}
