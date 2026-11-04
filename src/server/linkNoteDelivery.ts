// Delivers `linkNote` notes into Claude Code PTYs — only when it cannot hurt. The gate is nodeterm's
// (`src/renderer/lib/noteLink.ts:205-226` `linkNoteRefusal` + core `pty.sendToEmptyPrompt`):
// - never into a `working` agent (it would land mid-turn) or a `blocked` one (the Enter would answer
//   the permission prompt); `waiting` (turn over) and no-status-yet (fresh, at its prompt) are idle;
// - only when the input box is PROVEN empty on the rebuilt screen (`readClaudeComposer`): a draft,
//   a dialog, or an unreadable screen all refuse.
// Unlike nodeterm, a refused note is QUEUED, not dropped (the user asked to see every wire/unwire):
// each tick re-diffs what the node is wired to against what it was last told, so a queued note is
// always the current net change and a wire+unwire before delivery says nothing.
//
// Event-driven (F1-d), no timer: a pass runs on `edge.change` (wire/unwire/rename, recorded by the
// workspace save) and on the agent going idle (`hook.Stop`/`StopFailure`/`Notification`), so a wired
// cable is typed in well under 1 s and an idle server has no tick. No safety sweep: a note refused
// for a draft is announced by the draft's own UserPromptSubmit (additionalContext → `markTold`), or
// typed at the next idle hook. ponytail: a draft cleared without submitting waits for that hook.
import type { AgentStatus, Workspace } from '../shared/workspace'
import { hasClaudeHookSettings } from '../shared/workspace'
import { buildLinkDoc } from './contextLink'
import { markHookContextAnnounced } from './hookContext'
import { linkedBrowsers, markBrowsersAnnounced } from './linkAwareness'
import { buildLinkNote, linkEntries, type LinkEntry } from './linkNote'
import { composerText, readClaudeComposer } from './linkNoteComposer'
import { renderStyledScreen } from './linkNoteScreen'
import { createLogger } from './logs'
import { eventBus, type EventBus } from './events/eventBus'

const log = createLogger('linkNote')

export interface LinkNoteDeps {
  workspaces(): Workspace[]
  sessions: {
    statusOf(id: string): AgentStatus | undefined
    screenSource(id: string): { data: string; seq: number; cols: number; rows: number; pid: number } | undefined
    input(id: string, data: string): void
  }
  render?: (data: string, cols: number, rows: number) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

/** Enter goes in a SEPARATE write once the text is on screen: an Enter in the same burst is read by
 *  Claude Code as a line break and the note sits unsent (nodeterm `core/typed-input.ts`, measured). */
const SUBMIT_POLL_MS = 100
const SUBMIT_POLLS = 20

const idle = (s: AgentStatus | undefined): boolean => s === undefined || s === 'waiting'

export class LinkNoteDelivery {
  /** What each node was last told, tied to the PTY it was told in (a restart re-baselines). */
  private told = new Map<string, { pid: number; links: LinkEntry[] }>()
  /** The state a note was last refused in; unchanged state = skip the screen rebuild. */
  private refusedAt = new Map<string, string>()
  private running = false

  constructor(private deps: LinkNoteDeps) {}

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
          await this.consider(ws, n.id, src)
        }
      }
      for (const id of this.told.keys()) if (!seen.has(id)) { this.told.delete(id); this.refusedAt.delete(id) }
    } finally {
      this.running = false
    }
  }

  /** A hook just announced the current links via additionalContext: that counts as told. */
  markTold(nodeId: string, ws: Workspace): void {
    const pid = this.deps.sessions.screenSource(nodeId)?.pid
    if (pid !== undefined) this.told.set(nodeId, { pid, links: linkEntries(ws, nodeId) })
  }

  private async consider(ws: Workspace, id: string, src: NonNullable<ReturnType<LinkNoteDeps['sessions']['screenSource']>>): Promise<void> {
    const now = linkEntries(ws, id)
    const told = this.told.get(id)
    // First sight of this PTY: SessionStart's additionalContext lists the current links, so they
    // are the baseline, not news.
    if (!told || told.pid !== src.pid) { this.told.set(id, { pid: src.pid, links: now }); return }
    const note = buildLinkNote(told.links, now)
    if (!note) { this.refusedAt.delete(id); return }
    const status = this.deps.sessions.statusOf(id)
    if (!idle(status)) return
    const state = `${src.seq}\0${status}\0${note}`
    if (this.refusedAt.get(id) === state) return
    const composer = readClaudeComposer(await this.screen(src))
    if (composer !== 'empty') { this.refusedAt.set(id, state); return }
    this.refusedAt.delete(id)
    await this.deliver(ws, id, now, note)
  }

  private screen(src: { data: string; cols: number; rows: number }): Promise<string> {
    return (this.deps.render ?? renderStyledScreen)(src.data, src.cols, src.rows)
  }

  private async deliver(ws: Workspace, id: string, now: LinkEntry[], note: string): Promise<void> {
    const pid = this.deps.sessions.screenSource(id)?.pid
    if (pid === undefined) return
    // Marked BEFORE the write: submitting the note fires UserPromptSubmit, whose additionalContext
    // must see this change as already announced.
    this.told.set(id, { pid, links: now })
    markBrowsersAnnounced(id, linkedBrowsers(ws, id))
    markHookContextAnnounced(id, buildLinkDoc(ws, id))
    this.deps.sessions.input(id, note)
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let i = 0; i < SUBMIT_POLLS; i++) {
      await sleep(SUBMIT_POLL_MS)
      const src = this.deps.sessions.screenSource(id)
      if (!src) return
      if (composerText(await this.screen(src))?.startsWith('[webterm]')) {
        this.deps.sessions.input(id, '\r')
        log.info('linkNote.delivered', 'Link note delivered', { ids: { nodeId: id } })
        return
      }
    }
    // Typed but never seen on screen: the Enter is withheld (it could submit something else).
    log.warn('linkNote.notSubmitted', 'Link note typed but not confirmed on screen; Enter withheld', { ids: { nodeId: id } })
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
  const [{ db }, { sessions }] = await Promise.all([import('./db'), import('./sessions')])
  if (singleton) return singleton
  const delivery = new LinkNoteDelivery({ workspaces: () => db.list(), sessions })
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
