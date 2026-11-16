// Central is the notification hub, Telegram or not. One process-wide owner, started at boot:
//  - a sweep turns each new open inbox item (gate, question, review) into ONE notice in the Central
//    conversation the UI opens (`central:global`), even while the user is looking;
//  - one agent forwarder (channels/channelPresence.ts) writes "agent needs input / finished" notices
//    and, while a Telegram channel is up, mirrors the same text to the bound chats.
// The Telegram channel runtime only plugs in: its store becomes the agent mirror
// (`setTelegramNoticeMirror`), and its own card sweep (inbox/inboxPush.ts) sends the gate cards.
import type { Database } from 'bun:sqlite'
import { getRow } from '../ledger/ledgerCore'
import { createLogger } from '../logs'
import { attentionFor } from '../inbox/inboxAttention'
import { listInboxItems } from '../inbox/inboxItemStore'
import { inboxNoticeText } from '../channels/telegramCards'
import {
  presence as processPresence, startAgentForwarder, type ForwarderDeps, type ForwarderStore, type PresenceTracker,
} from '../channels/channelPresence'
import { describeAgentNode } from '../channels/channelPresenceDescribe'
import { eventBus } from '../events/eventBus'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { TELEGRAM_CHANNEL } from '../channels/channelDispatch'
import { DEFAULT_FORWARD_AWAY_MINUTES } from '../channels/channelStoreSchema'
import { redactSecrets } from '../redactSecrets'
import { appendCentralNotice } from './chat/conversationNotice'
import type { AssignmentChannel, WorkStatus } from '../../shared/centralWork'
import type { WorkMove } from './work/workModel'
import { RECOVER_RULE } from './work/workRecover.model'

const log = createLogger('central')
export const CENTRAL_NOTICE_INTERVAL_MS = 3000
const MINUTE_MS = 60_000
/** These run Claude with webterm's status hooks (Agent Chat too: the SDK runs PermissionRequest beside `canUseTool`), so the agent forwarder already announces their waits. */
const HOOK_FORWARDED: readonly AssignmentChannel[] = ['terminal', 'spawn', 'chat']
const WORK_NOTICE: Partial<Record<WorkStatus, string>> = { waiting_input: 'needs your input', stalled: 'has stalled', failed: 'failed', needs_review: 'is ready for review' }

let telegramMirror: ForwarderStore | null = null

/** The live Telegram store mirrors agent notices; returns the unplug function (clears only its own store). */
export function setTelegramNoticeMirror(store: ForwarderStore): () => void {
  telegramMirror = store
  return () => { if (telegramMirror === store) telegramMirror = null }
}

/**
 * One pass: a notice for every open item not seen yet (`seen` = item ids already handled; pruned to
 * the open ones). Muted news is skipped like the Telegram policy; gates ignore the mute. Idempotent
 * per item across restarts (the notice key), so a fresh `seen` never doubles a notice.
 * ponytail: the first page of open items (200); page further if one person ever has more waiting.
 */
export function sweepCentralNotices(db: Database, seen: Set<string>, opts: { now?: () => number; muted?: (workspaceId: string) => boolean } = {}): number {
  const now = opts.now ?? Date.now
  const items = listInboxItems({ db, now })
  let added = 0
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    if (attentionFor(item, { watching: () => false, muted: opts.muted ?? (() => false) }) === 'skip') continue
    const row = item.projectId ? getRow(db, 'SELECT name FROM project WHERE id = ?', item.projectId)?.['name'] : null
    try {
      if (appendCentralNotice(db, { key: `inbox:${item.id}`, text: inboxNoticeText(item, typeof row === 'string' ? row : null), now })) added++
    } catch (err) {
      seen.delete(item.id) // retried next sweep
      log.warn('central.notice_failed', `central notice for inbox item ${item.id} failed`, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const open = new Set(items.map((item) => item.id))
  for (const id of seen) if (!open.has(id)) seen.delete(id)
  return added
}

/**
 * Tells the user a task needs them, under the agent forwarder's rule (channelPresence.ts): only while
 * every tab has been away and the workspace is not muted, since someone at the board already sees it.
 * The key is the move's event, so one state entry is one notice in Central and one per bound chat.
 */
export function noticeWorkMove(db: Database, move: WorkMove, opts: { presence?: PresenceTracker; now?: () => number } = {}): void {
  const verb = WORK_NOTICE[move.to]
  // The recovery sweep steps a replaced session through `stalled` on its way to a respawn: not news (workCheckin ignores it too).
  if (move.rule === RECOVER_RULE) return
  if (!verb || (move.to === 'waiting_input' && move.channel !== null && HOOK_FORWARDED.includes(move.channel))) return
  const presence = opts.presence ?? processPresence
  const store = telegramMirror
  const minutes = store ? store.forwardAwayMinutes : DEFAULT_FORWARD_AWAY_MINUTES
  if (minutes === 0 || presence.awayMs() < minutes * MINUTE_MS) return
  const project = getRow(db, 'SELECT name, workspace_id FROM project WHERE id = ?', move.task.projectId)
  if (project && presence.isMuted(String(project['workspace_id']))) return
  const text = redactSecrets(`Task "${move.task.title}" in ${String(project?.['name'] ?? move.task.projectId)} ${verb}.`)
  const key = `work:${move.task.id}:${move.seq}`
  appendCentralNotice(db, { key, text, ...(opts.now ? { now: opts.now } : {}) })
  if (!store) return
  for (const { chatId, binding } of store.listBindings(TELEGRAM_CHANNEL)) {
    if (binding.projectId === move.task.projectId) store.enqueueReply({ key: `notice:${key}:${chatId}`, channel: TELEGRAM_CHANNEL, chatId, text })
  }
}

export interface CentralNoticesDeps {
  /** The ledger DB when its runtime is up; null = skip this pass (production: the active runtime). */
  db: () => Database | null
  subscribe: ForwarderDeps['subscribe']
  presence?: PresenceTracker
  describe?: ForwarderDeps['describe']
  now?: () => number
  intervalMs?: number
}

/** Starts the sweep and the agent forwarder; returns stop. Never throws into the timer or the bus. */
export function startCentralNotices(deps: CentralNoticesDeps): () => void {
  const presence = deps.presence ?? processPresence
  const now = deps.now ?? Date.now
  const stopForwarder = startAgentForwarder({
    store: () => telegramMirror,
    presence,
    subscribe: deps.subscribe,
    ...(deps.describe ? { describe: deps.describe } : {}),
    notice: (key, text) => {
      const db = deps.db()
      if (db) appendCentralNotice(db, { key, text, now })
    },
  })
  const seen = new Set<string>()
  const timer = setInterval(() => {
    try {
      const db = deps.db()
      if (db) sweepCentralNotices(db, seen, { now, muted: (ws) => presence.isMuted(ws) })
    } catch (err) {
      log.warn('central.notice_sweep_failed', 'central notice sweep failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }, deps.intervalMs ?? CENTRAL_NOTICE_INTERVAL_MS)
  timer.unref?.()
  return () => { clearInterval(timer); stopForwarder() }
}

let running: (() => void) | null = null

/** Production boot (index.ts): the active ledger runtime, the Senses bus and the workspace names. Idempotent. */
export function bootCentralNotices(): () => void {
  if (running) return running
  const stop = startCentralNotices({
    db: () => activeLedgerRuntime()?.db ?? null,
    subscribe: (pattern, fn) => eventBus.subscribe(pattern, fn),
    describe: describeAgentNode,
  })
  running = () => { stop(); running = null }
  return running
}
