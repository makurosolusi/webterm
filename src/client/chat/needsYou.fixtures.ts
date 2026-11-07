// test-only: fake ledger endpoints for the needs-you strip and approval card tests.
import { vi } from 'vitest'
import type { InboxItem } from '../inboxApi'
import type { UnifiedItem } from './needsYouApi'

const base = { source: 'agent', approvalKind: null, body: null, impact: null, args: null, count: 1 }

export const PERM: UnifiedItem = {
  ...base, id: 'perm_1', kind: 'gate', source: 'approval', approvalKind: 'agent.permission',
  title: 'brisk-otter wants to run: Bash(git push)',
  impact: { what: 'Runs Bash(git push), which reaches outside this machine', tier: 'R3', rewindable: false },
  actions: ['approve', 'deny', 'ignore', 'snooze', 'always'],
}
export const GATE: UnifiedItem = {
  ...base, id: 'gate_1', kind: 'gate', title: 'Run migration', body: 'Adds a column to users',
  impact: { what: 'Changes the database', tier: 'R1', rewindable: true }, args: { table: 'users' },
  actions: ['approve', 'edit', 'deny', 'ignore', 'snooze'],
}
export const QUESTION: UnifiedItem = { ...base, id: 'q1', kind: 'question', title: 'Which branch?', actions: ['reply', 'ignore', 'snooze'] }
/** A ledger approval: listed by both feeds, decided through the APPROVE dialog, never as a card. */
export const LEDGER: UnifiedItem = {
  ...base, id: 'appr_1', kind: 'gate', source: 'approval', approvalKind: 'deploy', title: 'Approval: deploy',
  actions: ['approve', 'deny', 'ignore', 'snooze'],
}

export const TASK_REVIEW: InboxItem = { id: 'task_1', kind: 'task', state: 'review', projectId: 'webterm', title: 'Fix login', ageMs: 0, fence: 3 }
export const TASK_BROKEN: InboxItem = { id: 'task_2', kind: 'task', state: 'broken', projectId: 'webterm', title: 'Build failed', ageMs: 0 }
export const LEDGER_ROW: InboxItem = { id: 'appr_1', kind: 'approval', state: 'needs_you', projectId: 'webterm', title: 'deploy', ageMs: 0 }
/** Projection copies of card items: must not be listed twice. */
export const DUP_ROWS: InboxItem[] = [
  { id: 'perm_1', kind: 'approval', state: 'needs_you', projectId: 'webterm', title: 'agent.permission', ageMs: 0 },
  { id: 'gate_1', kind: 'approval', state: 'needs_you', projectId: 'webterm', title: 'inbox.gate', ageMs: 0 },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export interface FakeLedger {
  items: UnifiedItem[]
  tasks: InboxItem[]
  posts: Array<{ url: string; body: Record<string, unknown> }>
  /** Next act answers with this status/body instead of 200. */
  actReply: { status: number; body: Record<string, unknown> } | null
  /** Hold every act until this resolves (to observe "deciding"). */
  actGate: Promise<void> | null
  itemsFail: boolean
}

/** Stubs `fetch` with the two ledger lists and the act route. Mutate the returned state freely. */
export function serveLedger(init: Partial<FakeLedger> = {}): FakeLedger {
  const s: FakeLedger = { items: [], tasks: [], posts: [], actReply: null, actGate: null, itemsFail: false, ...init }
  vi.stubGlobal('fetch', vi.fn(async (url: string, req?: RequestInit) => {
    if (req?.method === 'POST') {
      const body = JSON.parse(String(req.body)) as Record<string, unknown>
      s.posts.push({ url, body })
      if (s.actGate) await s.actGate
      if (s.actReply) return json(s.actReply.body, s.actReply.status)
      s.items = s.items.filter((i) => i.id !== body.id)
      s.tasks = s.tasks.filter((t) => t.id !== body.id) // the decided approval leaves the projection too
      return json({ id: body.id, resolution: (body.action as { type: string }).type === 'deny' ? 'denied' : 'approved' })
    }
    if (url.startsWith('/api/approvals/inbox')) return s.itemsFail ? json({ error: 'boom' }, 500) : json({ items: s.items, nextCursor: null })
    if (url.startsWith('/api/approvals?status=approved')) return json({ items: [] })
    if (url.startsWith('/api/inbox')) return json({ items: s.tasks })
    return json({ error: 'not_found' }, 404)
  }))
  return s
}
