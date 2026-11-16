// Live list of Central conversations, shared by the chat panel and the Dock badge (one poll, one source).
// Channel decision: the server has no global conversation-metadata stream (`centralChatSse` is per-conversation),
// so this polls GET /conversations. Polling stops while the tab is hidden and resumes at once on return.
import { useEffect, useSyncExternalStore } from 'react'
import { setChatBadgeCount } from '../osNotify.badge'
import { noteChatReply } from '../osNotify.chat'
import { setSideBar } from '../secondarySideBar.store'
import { chatErrorMessage, isAbortError } from './chatTransport'
import { readSeen, unreadIds, writeSeen, type SeenMap } from './chatUnread'
import { conversationLabel, type ChatClient, type ChatConversation } from './chatTypes'

export const CHAT_POLL_MS = 15_000

export interface ChatFeedState {
  rows: ChatConversation[] | null
  /** First load in flight (rows still null). */
  loading: boolean
  /** A later poll or Retry in flight. */
  refreshing: boolean
  /** Sticky until a fetch succeeds. */
  error: string | null
  nextOffset: number | null
  more: { loading: boolean; error: string | null }
  unread: ReadonlySet<string>
  /** Conversations that got a reply while another one was watched; cleared when opened. */
  replied: readonly string[]
  /** Conversation the OS banner asked to open; the panel consumes it. */
  openRequest: string | null
}

const INITIAL: ChatFeedState = {
  rows: null, loading: true, refreshing: false, error: null, nextOffset: null,
  more: { loading: false, error: null }, unread: new Set(), replied: [], openRequest: null,
}

let state = INITIAL
let seen: SeenMap = {}
let watched: string | null = null
let client: ChatClient | null = null
let refs = 0
let inflight: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

const hasFocus = (): boolean => typeof document === 'undefined' || document.hasFocus()
const isWatching = (id: string): boolean => watched === id && hasFocus()
const hidden = (): boolean => typeof document !== 'undefined' && document.hidden

function set(patch: Partial<ChatFeedState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Watching raises seenSeq; everything else past it is unread. Re-run on rows, watch and focus changes. */
function reconcile(patch: Partial<ChatFeedState> = {}): void {
  const rows = patch.rows ?? state.rows ?? []
  let dirty = false
  for (const row of rows) {
    if (isWatching(row.id) && row.lastMessageSeq > (seen[row.id] ?? 0)) { seen[row.id] = row.lastMessageSeq; dirty = true }
  }
  if (dirty) writeSeen(seen)
  const unread = unreadIds(rows, seen, isWatching)
  const replied = (patch.replied ?? state.replied).filter((id) => !isWatching(id))
  setChatBadgeCount(unread.size)
  set({ ...patch, unread, replied })
}

function seed(items: ChatConversation[]): void {
  for (const row of items) if (seen[row.id] === undefined) seen[row.id] = row.lastMessageSeq
}

function merge(items: ChatConversation[]): void {
  const prev = new Map((state.rows ?? []).map((row) => [row.id, row]))
  const first = state.rows === null
  if (first) { seed(items); writeSeen(seen) }
  const arrived = first ? [] : items.filter((row) => row.lastMessageSeq > (prev.get(row.id)?.lastMessageSeq ?? 0) && !isWatching(row.id))
  const rows = [...items, ...(state.rows ?? []).filter((row) => !items.some((item) => item.id === row.id))]
  const replied = [...new Set([...state.replied, ...arrived.map((row) => row.id)])]
  reconcile({ rows, replied, error: null, loading: false, refreshing: false })
  if (arrived.length > 0) {
    noteChatReply(arrived.map(conversationLabel), () => {
      setSideBar({ open: true, view: 'chat' })
      set({ openRequest: arrived[0]!.id })
    })
  }
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; if (!hidden()) refresh() }, CHAT_POLL_MS)
}

/** Fetch the first page now; a no-op while one is in flight. Failure is kept in `error`, never swallowed. */
export function refresh(): void {
  if (!client || inflight) return
  const controller = new AbortController()
  inflight = controller
  const first = state.rows === null
  set(first ? { loading: true, error: null } : { refreshing: true })
  client.listConversations({ signal: controller.signal }).then(
    (page) => {
      if (controller.signal.aborted) return
      inflight = null
      if (first) set({ nextOffset: page.nextOffset })
      merge(page.items)
      schedule()
    },
    (error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      inflight = null
      set({ loading: false, refreshing: false, error: chatErrorMessage(error) })
      schedule()
    }
  )
}

export function loadMore(): void {
  if (!client || state.nextOffset === null || state.more.loading) return
  set({ more: { loading: true, error: null } })
  client.listConversations({ offset: state.nextOffset }).then(
    (page) => {
      seed(page.items)
      writeSeen(seen)
      const known = new Set((state.rows ?? []).map((row) => row.id))
      reconcile({ rows: [...(state.rows ?? []), ...page.items.filter((row) => !known.has(row.id))], nextOffset: page.nextOffset, more: { loading: false, error: null } })
    },
    (error: unknown) => set({ more: { loading: false, error: `Could not load more: ${chatErrorMessage(error)}` } })
  )
}

/** A conversation created locally ("New chat"): in the list at once, nothing in it is unread. */
export function upsertConversation(row: ChatConversation): void {
  seen[row.id] = Math.max(seen[row.id] ?? 0, row.lastMessageSeq)
  writeSeen(seen)
  reconcile({ rows: [row, ...(state.rows ?? []).filter((other) => other.id !== row.id)] })
}

/** The conversation the user is looking at (selected + panel visible), or null. */
export function watchConversation(id: string | null): void {
  watched = id
  reconcile()
}

export function clearOpenRequest(): void {
  if (state.openRequest !== null) set({ openRequest: null })
}

const onVisible = (): void => { if (!hidden() && refs > 0) { if (timer !== null) clearTimeout(timer); timer = null; refresh() } }
const onFocus = (): void => { if (refs > 0) reconcile() }

/** Hold the feed open (ref-counted): the first holder starts polling, the last one stops and resets it. */
export function acquireChatFeed(next: ChatClient): () => void {
  if (refs++ === 0) {
    client = next
    seen = readSeen()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onFocus)
    refresh()
  }
  return () => {
    if (--refs > 0) return
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onFocus)
    inflight?.abort()
    inflight = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    client = null
    watched = null
    state = INITIAL
    setChatBadgeCount(0)
    for (const listener of listeners) listener()
  }
}

/** Keeps the feed alive while `enabled`; returns its live state. */
export function useChatFeed(feedClient: ChatClient, enabled = true): ChatFeedState {
  useEffect(() => (enabled ? acquireChatFeed(feedClient) : undefined), [feedClient, enabled])
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}
