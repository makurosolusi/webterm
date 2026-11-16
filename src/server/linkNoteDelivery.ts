// Link notes (`linkNote`) as OUTBOX mail: this module decides WHAT a Claude Code node must be told
// about its cables; `outbox/` decides WHEN and HOW it is delivered (idle + proven-empty composer,
// queued while busy, delivered at the end of the turn, exactly-once per operationId).
//
// A refused note is QUEUED, not dropped
// (the user asked to see every wire/unwire). Coalescing is kept by superseding: each pass diffs what
// the node is wired to now against what it was last TOLD, and the queued note for that node is
// replaced by the current net change (or cancelled when the net change is nothing), so a
// wire+unwire before delivery says nothing.
//
// Event-driven (F1-d), no timer: a pass runs on `edge.change` (wire/unwire/rename, recorded by the
// workspace save) and on the agent going idle; the outbox wakes itself on the same idle hooks.
import { createHash } from 'node:crypto'
import type { Workspace } from '../shared/workspace'
import { hasClaudeHookSettings } from '../shared/workspace'
import { buildLinkDoc } from './contextLink'
import { markHookContextAnnounced } from './hookContext'
import { linkedBrowsers, markBrowsersAnnounced } from './linkAwareness'
import { buildLinkNote, linkEntries, type LinkEntry } from './linkNote'
import { createLogger } from './logs'
import { eventBus, type EventBus } from './events/eventBus'
import type { OutboxDelivery } from './outbox/outboxDelivery'

const log = createLogger('linkNote')

/** operationId prefix of a node's link notes: `linknote:<nodeId>:<pid>:<rev>:<hash>`. */
export const LINK_NOTE_OP = 'linknote:'
const opPrefix = (nodeId: string): string => `${LINK_NOTE_OP}${nodeId}:`

export interface LinkNoteDeps {
  workspaces(): Workspace[]
  sessions: { screenSource(id: string): { pid: number } | undefined }
  outbox: Pick<OutboxDelivery, 'enqueue' | 'cancel' | 'register'>
}

export class LinkNoteDelivery {
  /** What each node was last told, tied to the PTY it was told in (a restart re-baselines). */
  private told = new Map<string, { pid: number; rev: number; links: LinkEntry[] }>()
  /** The state each queued note announces, applied when the outbox submits it. */
  private pending = new Map<string, { nodeId: string; pid: number; links: LinkEntry[]; ws: Workspace }>()
  private running = false

  constructor(private deps: LinkNoteDeps) {
    deps.outbox.register(LINK_NOTE_OP, {
      // A note this process did not compute (queued before a restart) describes a dead PTY: stale.
      accept: (m) => this.pending.has(m.operationId),
      // Right BEFORE the submitting Enter: that Enter fires UserPromptSubmit, whose
      // additionalContext must see this change as already announced.
      beforeSubmit: (m) => {
        const p = this.pending.get(m.operationId)
        if (!p) return
        this.pending.delete(m.operationId)
        this.setTold(p.nodeId, p.pid, p.links)
        markBrowsersAnnounced(p.nodeId, linkedBrowsers(p.ws, p.nodeId))
        markHookContextAnnounced(p.nodeId, buildLinkDoc(p.ws, p.nodeId))
        log.info('linkNote.delivered', 'Link note delivered', { ids: { nodeId: p.nodeId } })
      },
    })
  }

  /** One pass over every live Claude Code node. Re-entrant calls are skipped, never stacked. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const seen = new Set<string>()
      for (const ws of this.deps.workspaces()) {
        for (const n of ws.nodes) {
          if (!n.agentId || !hasClaudeHookSettings(n.agentId)) continue
          const src = this.deps.sessions.screenSource(n.id)
          if (!src) continue
          seen.add(n.id)
          this.consider(ws, n.id, src.pid)
        }
      }
      for (const id of this.told.keys()) if (!seen.has(id)) this.told.delete(id)
    } finally {
      this.running = false
    }
  }

  /** A hook just announced the current links via additionalContext: that counts as told. */
  markTold(nodeId: string, ws: Workspace): void {
    const pid = this.deps.sessions.screenSource(nodeId)?.pid
    if (pid === undefined) return
    this.setTold(nodeId, pid, linkEntries(ws, nodeId))
    this.supersede(nodeId)
  }

  private setTold(nodeId: string, pid: number, links: LinkEntry[]): void {
    this.told.set(nodeId, { pid, links, rev: (this.told.get(nodeId)?.rev ?? 0) + 1 })
  }

  /** Cancel the node's queued notes except `keepOp`, and forget what they would have announced. */
  private supersede(nodeId: string, keepOp?: string): void {
    this.deps.outbox.cancel(nodeId, opPrefix(nodeId), keepOp)
    for (const [op, p] of this.pending) if (p.nodeId === nodeId && op !== keepOp) this.pending.delete(op)
  }

  private consider(ws: Workspace, id: string, pid: number): void {
    const now = linkEntries(ws, id)
    const told = this.told.get(id)
    // First sight of this PTY: SessionStart's additionalContext lists the current links, so they
    // are the baseline, not news.
    if (!told || told.pid !== pid) { this.setTold(id, pid, now); this.supersede(id); return }
    const note = buildLinkNote(told.links, now)
    if (!note) { this.supersede(id); return }
    // `rev` makes the same text after a later change a NEW operation; within one rev a re-run of
    // this pass is a retry of the same operation and dedupes.
    const op = `${opPrefix(id)}${pid}:${told.rev}:${createHash('sha256').update(note).digest('hex').slice(0, 16)}`
    this.supersede(id, op)
    this.pending.set(op, { nodeId: id, pid, links: now, ws })
    this.deps.outbox.enqueue({ to: id, body: note, kind: 'visible', operationId: op, createdBy: 'linkNote' })
  }
}

let singleton: LinkNoteDelivery | undefined

/** Hook events after which the agent may be idle at an empty prompt. */
export const LINK_NOTE_IDLE_HOOKS: ReadonlySet<string> = new Set(['hook.Stop', 'hook.StopFailure', 'hook.Notification'])

/**
 * Runs `delivery.tick()` on every edge change and idle hook. Passes never overlap; an event during
 * a pass queues exactly one more pass (an event is never lost to the re-entrancy guard). Returns
 * the unsubscribe function and a `settled` promise for tests.
 */
export function subscribeLinkNotes(delivery: LinkNoteDelivery, bus: Pick<EventBus, 'subscribe'> = eventBus) {
  let current: Promise<void> | null = null
  let again = false
  const kick = (): void => {
    if (current) { again = true; return }
    current = (async () => {
      do {
        again = false
        await delivery.tick().catch((e) => log.error('linkNote.tick', 'Link note pass failed', { error: String(e) }))
      } while (again)
      current = null
    })()
  }
  const offEdge = bus.subscribe('edge.change', kick)
  const offHook = bus.subscribe('hook.*', (e) => { if (LINK_NOTE_IDLE_HOOKS.has(e.kind)) kick() })
  return {
    kick,
    settled: (): Promise<void> => current ?? Promise.resolve(),
    stop(): void { offEdge(); offHook() },
  }
}

/** Start the process-wide subscriber once (idempotent). Deps imported lazily: `db`/`sessions` pull
 *  `bun:sqlite` and the PTY, which node-env tests of the hook route must never load. */
export async function startLinkNotes(): Promise<LinkNoteDelivery> {
  if (singleton) return singleton
  const [{ db }, { sessions }, { startOutbox }] = await Promise.all([import('./db'), import('./sessions'), import('./outbox/outboxRuntime')])
  const outbox = await startOutbox()
  if (singleton) return singleton
  const delivery = new LinkNoteDelivery({ workspaces: () => db.list(), sessions, outbox })
  singleton = delivery
  // One pass now baselines every live PTY, so the first cable change after boot is news.
  subscribeLinkNotes(delivery).kick()
  return delivery
}

/** The hook route's half: the two events whose additionalContext states the current cables
 *  (`hookContext`/`linkAwareness`) count as told. No-op for other events and before the loop starts. */
export function linkNoteTold(nodeId: string, event: string | undefined, ws: Workspace): void {
  if (event === 'SessionStart' || event === 'UserPromptSubmit') singleton?.markTold(nodeId, ws)
}
