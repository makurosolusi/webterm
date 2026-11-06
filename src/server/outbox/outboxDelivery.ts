// Delivers outbox mail into agent sessions, only when it cannot hurt (PLAN F2-d, K2).
//
// Imitated design: Orca mailbox (`/tmp/st/orca-src/src/main/runtime/orchestration/`):
// - wake-not-poll: delivery runs on an arrival (`mailbox-notification-coordinator.ts:76-100`
//   `notifyMessageArrived` -> `deliverForHandle`) and on the agent's idle edge
//   (`mailbox-pointer-delivery.ts:193-198` `observeAgentIdle`). No timer, no sweep.
// - refusal parks, never drops (`mailbox-pointer-delivery.ts:64-68`: "refusal parks for recheck
//   instead of dropping mail"): a busy agent or a draft leaves the row `queued` for the next edge.
// - settled-input gate (`mailbox-pointer-delivery-contract.ts:24-26` `isAgentSettledForDelivery`):
//   here the gate of `linkNoteDelivery` (nodeterm `noteLink.ts:205-226`): never into `working`
//   (lands mid-turn) or `blocked` (the Enter would answer the permission prompt), and for Claude
//   Code only when the composer is PROVEN empty on the rebuilt screen.
// - one bounded batch per delivery (`mailbox-pointer-eligibility.ts:61-91`).
//
// Transport (K2): channel (only when enabled, see outboxChannel.ts) -> hook `additionalContext`
// for context-only items of a Claude node -> typed PTY. Typed PTY stays first-class.
import type { AgentId, AgentStatus, Workspace } from '../../shared/workspace'
import { hasClaudeHookSettings } from '../../shared/workspace'
import type { AppendEventInput } from '../events/eventModel'
import type { EventBus } from '../events/eventBus'
import { readClaudeComposer } from '../linkNoteComposer'
import { renderStyledScreen } from '../linkNoteScreen'
import { createLogger } from '../logs'
import type { ChannelAdapter } from './outboxChannel'
import type { EnqueueInput, OutboxKind, OutboxMessage, OutboxStore, OutboxTransport } from './outboxStore'

const log = createLogger('outbox')

export interface OutboxDeps {
  store: OutboxStore
  /** The node's agent id; null = not an agent node; undefined = node exists nowhere. */
  agentOf(nodeId: string): AgentId | null | undefined
  sessions: {
    statusOf(id: string): AgentStatus | undefined
    screenSource(id: string): { data: string; seq: number; cols: number; rows: number; pid: number } | undefined
    input(id: string, data: string): void
  }
  /** Senses log writer (production: `recordEvent`). */
  record(input: AppendEventInput): void
  channel?: ChannelAdapter
  render?: (data: string, cols: number, rows: number) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

/** Hook events whose reply Claude Code injects as `additionalContext` (see hookContext.ts). */
const HOOK_CONTEXT_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'UserPromptSubmit'])
/** Hook events after which the agent may be idle at an empty prompt (same set as linkNote). */
export const OUTBOX_WAKE_HOOKS: ReadonlySet<string> = new Set(['hook.Stop', 'hook.StopFailure', 'hook.Notification', 'hook.SessionStart'])
/** Enter is a SEPARATE write once the text is on screen (nodeterm `core/typed-input.ts`, measured). */
const SUBMIT_POLL_MS = 100
const SUBMIT_POLLS = 20
/** Non-Claude agents have no readable composer: same fixed gap the Diff-notes path used. */
export const SUBMIT_GAP_MS = 150
/** Ctrl-U: kill to line start, the clear-line every agent TUI honours (client agentActions KILL_LINE). */
const KILL_LINE = '\x15'
/** Wait before the one re-type of a batch whose text never showed up on screen. */
export const OUTBOX_RETYPE_BACKOFF_MS = 2_000
const UNCONFIRMED = 'typed but not confirmed on screen; Enter withheld'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** Producer hooks for one operationId prefix (see `register`). */
export interface DeliveryHook {
  /** false = this queued message is stale; it is cancelled instead of typed. */
  accept?(m: OutboxMessage): boolean
  /** Right before the submitting Enter (after the text is confirmed on screen). */
  beforeSubmit?(m: OutboxMessage): void
}

const idle = (s: AgentStatus | undefined): boolean => s === undefined || s === 'waiting'

/** K2 order: channel, then hook additionalContext (context-only, Claude hooks), then typed PTY. */
export function chooseTransport(kind: OutboxKind, caps: { channel: boolean; hooks: boolean }): OutboxTransport {
  if (caps.channel) return 'channel'
  if (kind === 'context' && caps.hooks) return 'hook'
  return 'pty'
}

export class OutboxDelivery {
  private busy = new Map<string, Promise<void>>()
  private again = new Set<string>()
  private hooks: Array<{ prefix: string; hook: DeliveryHook }> = []
  /** Message ids already re-typed once after an unconfirmed type (in memory: a restart grants one more). */
  private retyped = new Set<string>()

  constructor(private deps: OutboxDeps) {}

  /** Persist (exactly-once per operationId), record, and wake delivery for `to`. */
  enqueue(input: EnqueueInput): { message: OutboxMessage; deduped: boolean } {
    const res = this.deps.store.enqueue(input)
    if (!res.deduped) this.event('outbox.enqueue', res.message)
    void this.kick(input.to)
    return res
  }

  /** Why `to` cannot take mail, or null (checked at the enqueue boundary). */
  refusal(to: string): string | null {
    const agent = this.deps.agentOf(to)
    return agent === undefined ? 'node not found' : agent === null ? 'not an agent node' : null
  }

  /** Status view (newest first, paginated). */
  list(to: string, limit?: number, offset?: number): OutboxMessage[] {
    return this.deps.store.list(to, limit, offset)
  }

  /** Cancel `to`'s queued mail whose operationId starts with `prefix` (a superseded link note). */
  cancel(to: string, prefix: string, keepOp?: string): void {
    for (const m of this.deps.store.cancelQueued(to, prefix, keepOp)) this.event('outbox.cancel', m)
  }

  /** Let the producer of an operationId prefix veto stale mail and observe its submission. */
  register(prefix: string, hook: DeliveryHook): void {
    this.hooks.push({ prefix, hook })
  }

  /** The hook route's half: context-only mail rides this hook's additionalContext. */
  takeHookContext(nodeId: string, event: string | undefined): string | null {
    if (!event || !HOOK_CONTEXT_EVENTS.has(event)) return null
    const agent = this.deps.agentOf(nodeId)
    if (!agent || chooseTransport('context', this.caps(nodeId, agent)) !== 'hook') return null
    const items = this.deps.store.queued(nodeId, 'context')
    if (!items.length) return null
    this.settle(items, 'hook')
    return items.map((m) => m.body).join('\n\n')
  }

  /** Serialised per node; a wake during a pass queues exactly one more pass (never lost). */
  kick(nodeId: string): Promise<void> {
    const running = this.busy.get(nodeId)
    if (running) { this.again.add(nodeId); return running }
    const p = (async () => {
      do {
        this.again.delete(nodeId)
        await this.drain(nodeId).catch((e) => log.error('outbox.drain', 'Outbox delivery pass failed', { ids: { nodeId }, error: String(e) }))
      } while (this.again.has(nodeId))
      this.busy.delete(nodeId)
    })()
    this.busy.set(nodeId, p)
    return p
  }

  /** Nodes with queued mail. */
  queuedNodes(): string[] {
    return this.deps.store.queuedNodes()
  }

  /** Redrive every node with queued mail (boot: queued rows survive a restart). */
  async kickAll(): Promise<void> {
    await Promise.all(this.queuedNodes().map((n) => this.kick(n)))
  }

  private caps(nodeId: string, agent: AgentId | null): { channel: boolean; hooks: boolean } {
    return { channel: this.deps.channel?.available(nodeId) ?? false, hooks: !!agent && hasClaudeHookSettings(agent) }
  }

  private async drain(nodeId: string): Promise<void> {
    const queued = this.deps.store.queued(nodeId)
    if (!queued.length) return
    const agent = this.deps.agentOf(nodeId)
    if (agent === undefined) { this.fail(queued, null, 'node not found'); return }
    // SECURITY: a plain shell would EXECUTE the typed text; only agent sessions take mail.
    if (agent === null) { this.fail(queued, null, 'not an agent node'); return }
    const caps = this.caps(nodeId, agent)
    const byTransport = (t: OutboxTransport) => queued.filter((m) => chooseTransport(m.kind, caps) === t)
    for (const m of byTransport('channel')) {
      try { await this.deps.channel!.send(nodeId, m); this.settle([m], 'channel') } catch (e) { this.fail([m], 'channel', String(e)) }
    }
    const typed = byTransport('pty') // 'hook' items wait for the next UserPromptSubmit/SessionStart
    if (!typed.length) return
    const src = this.deps.sessions.screenSource(nodeId)
    if (!src || !idle(this.deps.sessions.statusOf(nodeId))) return // no live PTY / busy: stays queued
    if (caps.hooks && readClaudeComposer(await this.screen(src)) !== 'empty') return // draft/dialog: wait
    // Re-read after the await: a row may have been cancelled meanwhile; a producer may veto stale mail.
    const live = typed.filter((m) => this.deps.store.get(m.id)?.status === 'queued')
    const vetoed = live.filter((m) => this.hooksFor(m).some((h) => h.accept?.(m) === false))
    this.cancelRows(vetoed)
    const batch = live.filter((m) => !vetoed.includes(m))
    if (batch.length) await this.type(nodeId, batch, caps.hooks)
  }

  private async type(nodeId: string, batch: OutboxMessage[], claude: boolean): Promise<void> {
    const text = batch.map((m) => m.body).join('\n\n')
    this.deps.sessions.input(nodeId, text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text)
    const sleep = this.sleep()
    let landed = !claude
    if (claude) {
      for (let i = 0; i < SUBMIT_POLLS && !landed; i++) {
        await sleep(SUBMIT_POLL_MS)
        const src = this.deps.sessions.screenSource(nodeId)
        if (!src) break
        landed = readClaudeComposer(await this.screen(src)) === 'draft'
      }
    } else await sleep(SUBMIT_GAP_MS)
    // Typed but never seen on screen: the Enter is withheld (it could submit something else).
    if (!landed) { await this.unconfirmed(nodeId, batch, text); return }
    for (const m of batch) for (const h of this.hooksFor(m)) h.beforeSubmit?.(m)
    this.settle(batch, 'pty')
    this.deps.sessions.input(nodeId, '\r')
  }

  private sleep(): (ms: number) => Promise<void> {
    return this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  }

  /**
   * Undo the side effect first: the typed text may still be in the composer, where the next message
   * would be appended to it. Clear it (Ctrl-U per typed line, one write each so the TUI sees each
   * key), then re-queue each message once after a backoff; a second miss, or a composer that will
   * not clear, fails the message (re-typing onto leftover text would garble it).
   */
  private async unconfirmed(nodeId: string, batch: OutboxMessage[], text: string): Promise<void> {
    const sleep = this.sleep()
    for (let i = 0; i < text.split('\n').length; i++) {
      this.deps.sessions.input(nodeId, KILL_LINE)
      await sleep(SUBMIT_POLL_MS)
    }
    const src = this.deps.sessions.screenSource(nodeId)
    const cleared = !!src && readClaudeComposer(await this.screen(src)) === 'empty'
    const fresh = cleared ? batch.filter((m) => !this.retyped.has(m.id)) : []
    const done = batch.filter((m) => !fresh.includes(m))
    if (done.length) this.fail(done, 'pty', cleared ? UNCONFIRMED : `${UNCONFIRMED}; composer could not be cleared`)
    if (!fresh.length) return
    for (const m of fresh) this.retyped.add(m.id)
    log.info('outbox.retype', 'Outbox text not confirmed on screen; composer cleared, re-typing once', { ids: { nodeId }, count: fresh.length })
    await sleep(OUTBOX_RETYPE_BACKOFF_MS)
    this.again.add(nodeId) // the per-node pass loops once more and re-checks every gate
  }

  private hooksFor(m: OutboxMessage): DeliveryHook[] {
    return this.hooks.filter((h) => m.operationId.startsWith(h.prefix)).map((h) => h.hook)
  }

  private cancelRows(items: OutboxMessage[]): void {
    this.deps.store.markCancelled(items.map((m) => m.id))
    for (const m of items) this.event('outbox.cancel', m)
  }

  private screen(src: { data: string; cols: number; rows: number }): Promise<string> {
    return (this.deps.render ?? renderStyledScreen)(src.data, src.cols, src.rows)
  }

  private settle(items: OutboxMessage[], transport: OutboxTransport): void {
    for (const m of items) this.retyped.delete(m.id)
    this.deps.store.markDelivered(items.map((m) => m.id), transport)
    for (const m of items) this.event('outbox.deliver', { ...m, transport })
  }

  private fail(items: OutboxMessage[], transport: OutboxTransport | null, error: string): void {
    for (const m of items) this.retyped.delete(m.id)
    this.deps.store.markFailed(items.map((m) => m.id), transport, error)
    for (const m of items) this.event('outbox.fail', { ...m, transport, error })
    log.warn('outbox.fail', 'Outbox delivery failed', { ids: { nodeId: items[0]?.to }, count: items.length, error })
  }

  /** Metadata only: the body never enters the Senses log (Rule 12). */
  private event(kind: string, m: OutboxMessage): void {
    this.deps.record({
      kind, source: 'outbox', actor: m.createdBy, subject: `node:${m.to}`, nodeId: m.to, trust: 'trusted',
      payload: { id: m.id, operationId: m.operationId, kind: m.kind, priority: m.priority, transport: m.transport, error: m.error },
    })
  }
}

/** Wake on idle-edge hooks of the addressed node. Returns the unsubscribe function. */
export function subscribeOutbox(outbox: OutboxDelivery, bus: Pick<EventBus, 'subscribe'>): () => void {
  return bus.subscribe('hook.*', (e) => { if (e.nodeId && OUTBOX_WAKE_HOOKS.has(e.kind)) void outbox.kick(e.nodeId) })
}

/** Agent id of `nodeId` across workspaces (null = not an agent, undefined = nowhere). */
export function agentIn(workspaces: readonly Workspace[], nodeId: string): AgentId | null | undefined {
  for (const ws of workspaces) {
    const n = ws.nodes.find((x) => x.id === nodeId)
    if (n) return n.agentId ?? null
  }
  return undefined
}
