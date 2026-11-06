// Shared fixture for inboxItems*.bun.test.ts: a fresh ledger schema on a test clock, the inbox
// action deps that record decision events, and a one-line gate factory.
import { freshDb, T0 } from '../central/guard/controlGuard.testutil'
import type { AppendEventInput } from '../events/eventModel'
import { createOutboxStore } from '../outbox/outboxStore'
import type { InboxActDeps } from './inboxActions'
import type { Impact } from './inboxItemModel'
import { createGate } from './inboxItemStore'

export const R2: Impact = { what: 'Runs the migration', tier: 'R2', rewindable: true }
export const R3: Impact = { what: 'Publishes the package', tier: 'R3', rewindable: false }

/** A fresh db, a movable clock, the recorded events, the outbox and the inbox action deps. */
export function setup() {
  const db = freshDb()
  const clock = { t: T0 }
  const ctx = { db, now: () => clock.t }
  const events: AppendEventInput[] = []
  const outbox = createOutboxStore(db, ctx.now)
  const deps: InboxActDeps = {
    ctx, actor: 'human:loopback', record: (e) => { events.push(e) },
    outbox: async () => ({ refusal: (to: string) => (to === 'gone' ? 'node gone is not an agent' : null), enqueue: (i) => outbox.enqueue(i) }),
  }
  return { db, ctx, clock, events, outbox, deps }
}

/** An editable central gate in project p1 for node a1. */
export const gate = (s: ReturnType<typeof setup>, impact = R2, args: unknown = { table: 'users' }) =>
  createGate(s.ctx, { projectId: 'p1', source: 'central', title: 'Run migration 0042', args, impact, editable: true, nodeId: 'a1', workspaceId: 'w1' })
