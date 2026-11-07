// Telegram mirror of inbox items under the attention policy (F3-a): the Central notice for each item
// is written by central/centralNotices.ts (always on); this sweep sends the matching card to the
// bound approver chats, once per item, while a Telegram channel is up. A sweep, not an event hook,
// because gates come from several producers (Claude permission prompts, task reviews, Central) that
// all end in one `approval` table: one cheap SELECT finds them all. Each item is pushed at most once
// (`pushed_at`; a snooze clears it so the item pings again when it resurfaces); a held item is
// retried by the next sweep, so a gate you were watching still reaches you once you walk away.
import type { Database } from 'bun:sqlite'
import { getRow, type LedgerContext } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { APPROVAL_ROLES, type ChannelBinding } from '../channels/identity'
import { renderInboxCard, sendTelegramCard, type CardSendOptions, type TelegramCard } from '../channels/telegramCards'
import type { PresenceTracker } from '../channels/channelPresence'
import { attentionFor, type AttentionContext } from './inboxAttention'
import { ensureDailyDigest, markPushed, syncApprovalGates, syncDiffNoteReviews, unpushedItems, type PushScope } from './inboxItemStore'

const log = createLogger('inbox')
export const INBOX_PUSH_INTERVAL_MS = 3000
/** A visible tab pinged this recently = the user is at webterm (used for items with no node). */
export const WATCHING_MS = 60_000

export interface PushDeps {
  ctx: LedgerContext
  /** Chats that may receive this project's cards; `null` = every approver chat (the digest). */
  chatsFor(projectId: string | null): string[]
  /** Projects with at least one chat in `chatsFor`; only their items are read, so unbound ones never starve them. */
  boundProjects(): string[]
  attention: AttentionContext
  send(chatId: string, card: TelegramCard): Promise<boolean>
}

export async function sweepInboxPush(deps: PushDeps): Promise<{ pushed: string[]; held: string[] }> {
  syncApprovalGates(deps.ctx)
  syncDiffNoteReviews(deps.ctx)
  ensureDailyDigest(deps.ctx)
  const pushed: string[] = []
  const held: string[] = []
  const scope: PushScope = { projectIds: deps.boundProjects(), unscoped: deps.chatsFor(null).length > 0 }
  // Keyset pages: held items (still unpushed) must not hide a deliverable item behind a fixed window.
  for (let seq: number | null = 0; seq !== null;) {
    const page = unpushedItems(deps.ctx, scope, seq)
    seq = page.nextSeq
    for (const item of page.items) {
      const verdict = attentionFor(item, deps.attention)
      if (verdict === 'skip') { markPushed(deps.ctx, item.id); continue }
      if (verdict === 'hold') { held.push(item.id); continue }
      const chats = deps.chatsFor(item.projectId)
      if (chats.length === 0) continue // binding removed mid-sweep; a later binding still gets it
      const name = item.projectId ? getRow(deps.ctx.db, 'SELECT name FROM project WHERE id = ?', item.projectId)?.['name'] : null
      const card = renderInboxCard(item, typeof name === 'string' ? name : null)
      let ok = false
      for (const chat of chats) ok = (await deps.send(chat, card)) || ok
      if (ok) { markPushed(deps.ctx, item.id); pushed.push(item.id) }
    }
  }
  return { pushed, held }
}

/** Approver/owner private chats bound to the project (the same roles that may press the buttons). */
export function approverChats(bindings: Array<{ chatId: string; binding: ChannelBinding }>, projectId: string | null): string[] {
  const chats = bindings.filter((b) => APPROVAL_ROLES.includes(b.binding.role) && (projectId === null || b.binding.projectId === projectId)).map((b) => b.chatId)
  return [...new Set(chats)]
}

/** Projects that have an approver/owner chat, i.e. where `approverChats` is non-empty. */
export function approverProjects(bindings: Array<{ binding: ChannelBinding }>): string[] {
  return [...new Set(bindings.filter((b) => APPROVAL_ROLES.includes(b.binding.role)).map((b) => b.binding.projectId))]
}

/**
 * Orca suppress-while-focused, per node: an item about node X is held only while the user's focused
 * window is on X (presence ping `nodeId`); being on another node does not count. An item with no
 * node is held while any webterm tab is in use.
 */
export function watchingFrom(p: Pick<PresenceTracker, 'awayMs' | 'focusedNode'>, item: { nodeId: string | null }): boolean {
  if (item.nodeId) return p.focusedNode()?.nodeId === item.nodeId
  return p.awayMs() < WATCHING_MS
}

export interface TelegramPushWiring {
  db: Database
  store: { listBindings(channel?: string): Array<{ chatId: string; binding: ChannelBinding }> }
  presence: Pick<PresenceTracker, 'awayMs' | 'isMuted' | 'focusedNode'>
  send?: CardSendOptions
  now?: () => number
  intervalMs?: number
}

/**
 * Production loop; call next to `startAgentForwarder` in `channelsRuntime.ts`. Returns stop.
 * ponytail: polls every 3 s; switch to an approval-created event if latency ever matters.
 */
export function startInboxTelegramPush(w: TelegramPushWiring): () => void {
  const deps: PushDeps = {
    ctx: { db: w.db, now: w.now ?? Date.now },
    chatsFor: (projectId) => approverChats(w.store.listBindings('telegram'), projectId),
    boundProjects: () => approverProjects(w.store.listBindings('telegram')),
    attention: { watching: (item) => watchingFrom(w.presence, item), muted: (ws) => w.presence.isMuted(ws) },
    send: (chat, card) => sendTelegramCard(chat, card, w.send),
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepInboxPush(deps)
      .catch((err: unknown) => log.warn('inbox.push.failed', 'inbox push sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false })
  }, w.intervalMs ?? INBOX_PUSH_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
