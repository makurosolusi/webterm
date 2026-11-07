// Agent notices (F2-g). When every browser tab has been away longer than the configured minutes
// (default 3, like Orca DESKTOP_AWAY_SECONDS = 180) and an agent finishes or needs input, ONE notice
// is appended to the Central conversation (`notice` dep, the single source the UI shows), whether or
// not Telegram is on. When a Telegram channel is up (`store` returns it) the same text is mirrored to
// the chats bound to that workspace, through the same outbox (and so the same renderer and retry) as
// every other reply. Muted workspaces never forward. One process-wide forwarder owns this
// (central/centralNotices.ts); the channel runtime only plugs its store in as the mirror.
//
// Presence is a heartbeat: a visible tab pings `POST /api/channels/presence` (channelPresenceHttp);
// hidden or closed tabs send nothing, so "away" = time since the last visible ping. The tracker is
// process-wide so a channel runtime rebuild (telegramHot.refresh) does not reset it.
import type { SenseEvent } from '../events/eventModel'
import { createLogger } from '../logs'
import { TELEGRAM_CHANNEL } from './channelDispatch'
import type { EnqueueReplyInput, EnqueueReplyOutcome } from './channelStore'
import type { ChannelBinding } from './identity'
import { DEFAULT_FORWARD_AWAY_MINUTES } from './channelStoreSchema'

const log = createLogger('channels')
const MINUTE_MS = 60_000
const VERB: Record<string, string> = { done: 'finished', waiting: 'needs input', blocked: 'needs approval' }

/** A focused-node claim older than this is stale (the tab pings every 30 s and on selection change). */
export const FOCUS_FRESH_MS = 45_000

export interface PresenceTracker {
  /**
   * One ping from a tab; `muted` = that browser's muted workspace ids (osNotify prefs); `nodeId` =
   * the canvas node the user is on in a focused window (null = none), `workspaceId` its board.
   */
  note(input: { visible: boolean; muted?: readonly string[]; nodeId?: string | null; workspaceId?: string | null }): void
  awayMs(): number
  isMuted(workspaceId: string): boolean
  /** Node the user is looking at right now (fresh visible ping that named it), else null. */
  focusedNode(): { nodeId: string; workspaceId: string | null } | null
}

/** Boot counts as "seen": a fresh server does not forward before anyone had a chance to look. */
export function createPresenceTracker(now: () => number = Date.now): PresenceTracker {
  let lastVisibleAt = now()
  // ponytail: last ping's mute list wins; per-browser lists merged only if several browsers diverge in practice.
  let muted = new Set<string>()
  // ponytail: last ping wins across tabs, like the mute list.
  let focus: { nodeId: string; workspaceId: string | null; at: number } | null = null
  return {
    note({ visible, muted: list, nodeId, workspaceId }) {
      if (visible) lastVisibleAt = now()
      if (list) muted = new Set(list)
      if (nodeId !== undefined) focus = visible && nodeId ? { nodeId, workspaceId: workspaceId ?? null, at: now() } : null
    },
    awayMs: () => now() - lastVisibleAt,
    isMuted: (workspaceId) => muted.has(workspaceId),
    focusedNode: () => (focus && now() - focus.at < FOCUS_FRESH_MS ? { nodeId: focus.nodeId, workspaceId: focus.workspaceId } : null),
  }
}

/** Process-wide tracker used by the HTTP ping and the production forwarder. */
export const presence = createPresenceTracker()

/** The Telegram side of a notice: the delay setting, the bound chats and the outbox. */
export interface ForwarderStore {
  readonly forwardAwayMinutes: number
  listBindings(channel?: string): Array<{ chatId: string; binding: ChannelBinding }>
  enqueueReply(input: EnqueueReplyInput): EnqueueReplyOutcome
}

export interface ForwarderDeps {
  /** The live Telegram store, or a getter for it (null = Telegram off: Central notice only, default delay). */
  store: ForwarderStore | (() => ForwarderStore | null)
  presence: PresenceTracker
  /** `hook.*` subscription; returns the unsubscribe function (production: eventBus). */
  subscribe(pattern: string, fn: (event: SenseEvent) => void): () => void
  /** Node label + workspace name for the notice; null = unknown node (still forwarded, generic). */
  describe?(nodeId: string, workspaceId: string): { label: string; workspace: string } | null
  /** Appends the notice to the Central conversation (production: `appendCentralNotice`); idempotent per key. */
  notice?(key: string, text: string): void
}

/** The notice text; plain words, rendered by the shared Telegram renderer at send time. */
export function renderAgentNotice(status: string, who: { label: string; workspace: string } | null): string {
  const verb = VERB[status] ?? status
  return who ? `${who.label} ${verb} in ${who.workspace}.` : `An agent ${verb}.`
}

/** Subscribes to hook events; returns the stop function. Never throws into the event bus. */
export function startAgentForwarder(deps: ForwarderDeps): () => void {
  const last = new Map<string, string>()
  return deps.subscribe('hook.*', (event) => {
    const status = (event.payload as { status?: unknown } | null)?.status
    if (typeof status !== 'string' || !event.nodeId || !event.workspaceId) return
    const prev = last.get(event.nodeId)
    last.set(event.nodeId, status)
    // Transition only: a repeated status (or a replay) is not news. `working` never notifies.
    if (!(status in VERB) || prev === status) return
    const store = typeof deps.store === 'function' ? deps.store() : deps.store
    const minutes = store ? store.forwardAwayMinutes : DEFAULT_FORWARD_AWAY_MINUTES
    if (minutes === 0 || deps.presence.awayMs() < minutes * MINUTE_MS) return
    if (deps.presence.isMuted(event.workspaceId)) return
    let who: { label: string; workspace: string } | null = null
    try {
      who = deps.describe?.(event.nodeId, event.workspaceId) ?? null
    } catch (err) {
      log.warn('channels.forward_describe_failed', 'agent notice sent without names', { error: err instanceof Error ? err.name : typeof err })
    }
    const text = renderAgentNotice(status, who)
    const key = `${event.nodeId}:${event.seq}:${event.ts}`
    try {
      deps.notice?.(`agent:${key}`, text)
    } catch (err) {
      log.warn('channels.forward_notice_failed', 'agent notice not added to the Central conversation', { error: err instanceof Error ? err.name : typeof err })
    }
    // ponytail: a chat bound to project id == workspace id (how synced projects are created);
    // a ledger lookup is needed only if projects ever get ids of their own.
    if (!store) return
    const chats = store.listBindings(TELEGRAM_CHANNEL).filter((b) => b.binding.projectId === event.workspaceId)
    for (const { chatId } of chats) {
      try {
        store.enqueueReply({ key: `notice:${key}:${chatId}`, channel: TELEGRAM_CHANNEL, chatId, text })
      } catch (err) {
        log.warn('channels.forward_failed', 'agent notice enqueue failed', { error: err instanceof Error ? err.name : typeof err })
      }
    }
  })
}
