// The one text surface of a Files node: every message (upload progress/result, reveal/copy failures,
// "already exists", any slot) goes through this per-node store and renders in the footer live region.
// Kinds: `info` auto-dismisses after NOTICE_INFO_MS, `progress` stays until replaced (optional Cancel),
// `error` is sticky until dismissed (optional actions such as Retry).
import { useSyncExternalStore } from 'react'

export type NoticeKind = 'info' | 'progress' | 'error'
/** Icon action on a notice; `icon` is a codicon name, `label` its accessible name + tooltip. */
export interface NoticeAction { label: string; icon: string; run(): void }
export interface FilesNotice {
  id: string
  kind: NoticeKind
  text: string
  /** Longer text shown on hover (e.g. every failed name). */
  detail?: string
  /** Determinate progress 0..1; drawn as the thin bar on top of the list. */
  progress?: number
  onCancel?(): void
  actions?: NoticeAction[]
}
export type NoticeInput = Omit<FilesNotice, 'id'> & { id?: string }

/** How long an `info` notice stays before it dismisses itself. */
export const NOTICE_INFO_MS = 4000

const EMPTY: readonly FilesNotice[] = []
const byNode = new Map<string, readonly FilesNotice[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const subs = new Set<() => void>()
let seq = 0
const emit = () => { subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const timerKey = (nodeId: string, id: string) => `${nodeId}\u0000${id}`

function stopTimer(nodeId: string, id: string): void {
  const k = timerKey(nodeId, id)
  clearTimeout(timers.get(k))
  timers.delete(k)
}

/**
 * Show (or replace, by `id`) a notice on node `nodeId`; returns its id. A replaced notice moves to the
 * front unless it is a progress tick (progress -> progress), so a newer event is never hidden by ticks.
 */
export function notify(nodeId: string, input: NoticeInput): string {
  const id = input.id ?? `n${++seq}`
  const n: FilesNotice = { ...input, id }
  const list = byNode.get(nodeId) ?? EMPTY
  const at = list.findIndex((x) => x.id === id)
  const tick = at >= 0 && list[at].kind === 'progress' && n.kind === 'progress'
  byNode.set(nodeId, tick ? list.map((x, i) => (i === at ? n : x)) : [...list.filter((x) => x.id !== id), n])
  stopTimer(nodeId, id)
  if (n.kind === 'info') timers.set(timerKey(nodeId, id), setTimeout(() => dismissNotice(nodeId, id), NOTICE_INFO_MS))
  emit()
  return id
}

/** Remove notice `id` from node `nodeId` (no-op when absent). */
export function dismissNotice(nodeId: string, id: string): void {
  stopTimer(nodeId, id)
  const list = byNode.get(nodeId)
  if (!list?.some((x) => x.id === id)) return
  const next = list.filter((x) => x.id !== id)
  if (next.length) byNode.set(nodeId, next)
  else byNode.delete(nodeId)
  emit()
}

/** Drop every notice and timer of node `nodeId` (the node is gone for good). */
export function forgetFilesNotices(nodeId: string): void {
  for (const n of byNode.get(nodeId) ?? EMPTY) stopTimer(nodeId, n.id)
  if (byNode.delete(nodeId)) emit()
}

/** Notices of node `nodeId`, oldest first (the footer shows the last one). */
export const useFilesNotices = (nodeId: string): readonly FilesNotice[] =>
  useSyncExternalStore(subscribe, () => byNode.get(nodeId) ?? EMPTY)

/** Current notices of a node (for tests and non-React callers). */
export const noticesOf = (nodeId: string): readonly FilesNotice[] => byNode.get(nodeId) ?? EMPTY

/** Reset the module state (tests). */
export function resetFilesNotices(): void {
  timers.forEach((t) => clearTimeout(t))
  timers.clear()
  byNode.clear()
  emit()
}
