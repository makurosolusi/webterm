// Sync mode of a split browser node, client side: the view of the server's `sync`/`syncMiss` messages and the one REST call.
// State is per session (the server never saves it), so a fresh window learns it from the attach message.
import type { ServerMsg } from '../../shared/browser.contract'
import { request } from '../browser.api'

export type SyncMsg = Extract<ServerMsg, { t: 'sync' | 'syncMiss' }>
export type MissReason = Extract<SyncMsg, { t: 'syncMiss' }>['reason']
export interface SyncView { on: boolean; miss: Readonly<Record<string, { reason: MissReason; at: number }>> }

export const SYNC_OFF: SyncView = { on: false, miss: {} }
/** How long a pane keeps its "no match" mark; the next mirrored action replaces it sooner. */
export const MISS_TTL_MS = 6000
/** Shown once, before sync is turned on the first time in this browser. */
export const SYNC_WARNING = 'Actions you take will repeat in every pane'

export const isSyncMsg = (m: ServerMsg): m is SyncMsg => m.t === 'sync' || m.t === 'syncMiss'

/** Fold one server message into the view. Turning sync off clears the marks. */
export function applySyncMsg(v: SyncView, m: SyncMsg, now: number): SyncView {
  if (m.t === 'sync') return m.on ? { ...v, on: true } : SYNC_OFF
  return { ...v, miss: { ...v.miss, [m.tab]: { reason: m.reason, at: now } } }
}

export const MISS_LABEL: Record<MissReason, string> = { no_match: 'No match', cross_origin: 'Skipped: submits elsewhere', error: 'Sync failed here' }
export const MISS_TITLE: Record<MissReason, string> = {
  no_match: 'This page has no element with the same role and name as the one you used in the other pane',
  cross_origin: 'The matching control submits to another site, so it was not clicked here',
  error: 'The action could not be repeated in this pane',
}

/** The mark of a pane while it is fresh, else undefined. */
export function activeMiss(v: SyncView, tabId: string, now: number): { reason: MissReason; at: number } | undefined {
  const m = v.miss[tabId]
  return m && now - m.at < MISS_TTL_MS ? m : undefined
}

export const setSync = (nodeId: string, on: boolean) => request<{ on: boolean }>('POST', `/${encodeURIComponent(nodeId)}/sync`, { on })

const ACK_KEY = 'webterm.browserSync.warned'
let warned = false
/** Has the warning been shown before (this page load, or an earlier one)? Storage may be blocked: then it is asked each load. */
export function syncWarned(): boolean {
  if (warned) return true
  try { warned = localStorage.getItem(ACK_KEY) === '1' } catch { warned = false }
  return warned
}
export function rememberSyncWarned(): void {
  warned = true
  try { localStorage.setItem(ACK_KEY, '1') } catch { /* private window or blocked storage: the warning shows again next load */ }
}
/** Test hook: forget that the warning was shown. */
export function resetSyncWarned(): void {
  warned = false
  try { localStorage.removeItem(ACK_KEY) } catch { /* nothing stored to forget */ }
}
