// Desktop -> Telegram forwarding (F2-g). When every browser tab has been away longer than the
// configured minutes (default 3, like Orca DESKTOP_AWAY_SECONDS = 180) and an agent finishes or
// needs input, a short notice goes to the chats bound to that workspace, through the same outbox
// (and so the same renderer and retry) as every other reply. Muted workspaces never forward.
//
// Presence is a heartbeat: a visible tab pings `POST /api/channels/presence` (channelPresenceHttp);
// hidden or closed tabs send nothing, so "away" = time since the last visible ping. The tracker is
// process-wide so a channel runtime rebuild (telegramHot.refresh) does not reset it.
import type { SenseEvent } from '../events/eventModel'
import { createLogger } from '../logs'
import { TELEGRAM_CHANNEL } from './channelDispatch'
import type { EnqueueReplyInput, EnqueueReplyOutcome } from './channelStore'
import type { ChannelBinding } from './identity'

const log = createLogger('channels')
const MINUTE_MS = 60_000
const VERB: Record<string, string> = { done: 'finished', waiting: 'needs input', blocked: 'needs approval' }

export interface PresenceTracker {
  /** One ping from a tab; `muted` = that browser's muted workspace ids (osNotify prefs). */
  note(input: { visible: boolean; muted?: readonly string[] }): void
  awayMs(): number
  isMuted(workspaceId: string): boolean
}

/** Boot counts as "seen": a fresh server does not forward before anyone had a chance to look. */
export function createPresenceTracker(now: () => number = Date.now): PresenceTracker {
  let lastVisibleAt = now()
  // ponytail: last ping's mute list wins; per-browser lists merged only if several browsers diverge in practice.
  let muted = new Set<string>()
  return {
    note({ visible, muted: list }) {
      if (visible) lastVisibleAt = now()
      if (list) muted = new Set(list)
    },
    awayMs: () => now() - lastVisibleAt,
    isMuted: (workspaceId) => muted.has(workspaceId),
  }
}

/** Process-wide tracker used by the HTTP ping and the production forwarder. */
export const presence = createPresenceTracker()

export interface ForwarderDeps {
  store: {
    readonly forwardAwayMinutes: number
    listBindings(channel?: string): Array<{ chatId: string; binding: ChannelBinding }>
    enqueueReply(input: EnqueueReplyInput): EnqueueReplyOutcome
  }
  presence: PresenceTracker
  /** `hook.*` subscription; returns the unsubscribe function (production: eventBus). */
  subscribe(pattern: string, fn: (event: SenseEvent) => void): () => void
  /** Node label + workspace name for the notice; null = unknown node (still forwarded, generic). */
  describe?(nodeId: string, workspaceId: string): { label: string; workspace: string } | null
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
    const minutes = deps.store.forwardAwayMinutes
    if (minutes === 0 || deps.presence.awayMs() < minutes * MINUTE_MS) return
    if (deps.presence.isMuted(event.workspaceId)) return
    // ponytail: a chat bound to project id == workspace id (how synced projects are created);
    // a ledger lookup is needed only if projects ever get ids of their own.
    const chats = deps.store.listBindings(TELEGRAM_CHANNEL).filter((b) => b.binding.projectId === event.workspaceId)
    if (chats.length === 0) return
    let who: { label: string; workspace: string } | null = null
    try {
      who = deps.describe?.(event.nodeId, event.workspaceId) ?? null
    } catch (err) {
      log.warn('channels.forward_describe_failed', 'agent notice sent without names', { error: err instanceof Error ? err.name : typeof err })
    }
    const text = renderAgentNotice(status, who)
    for (const { chatId } of chats) {
      try {
        deps.store.enqueueReply({ key: `notice:${event.nodeId}:${event.seq}:${event.ts}:${chatId}`, channel: TELEGRAM_CHANNEL, chatId, text })
      } catch (err) {
        log.warn('channels.forward_failed', 'agent notice enqueue failed', { error: err instanceof Error ? err.name : typeof err })
      }
    }
  })
}
