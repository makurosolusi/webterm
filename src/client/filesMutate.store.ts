// State UI slot mutate per node (dialog konfirmasi + toast). Slot adalah singleton modul, jadi state
// per-node hidup di sini (kunci = nodeId), dibaca React lewat `useSyncExternalStore`.
import { useSyncExternalStore } from 'react'

export interface Confirm {
  names: string[]
  permanent: boolean
  /** Folder saat diminta; konfirmasi memakai ini, bukan folder node pada saat klik "ya". */
  dir: string
  onConfirm: () => void
}
export interface ToastAction { label: string; onClick: () => void }
export interface Toast {
  id: string
  severity: 'info' | 'warning' | 'error'
  title: string
  message?: string
  actions?: ToastAction[]
}
export interface MutateUi { confirm: Confirm | null; toasts: Toast[] }

let seq = 0
const EMPTY: MutateUi = { confirm: null, toasts: [] }
const state = new Map<string, MutateUi>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

const get = (nodeId: string): MutateUi => state.get(nodeId) ?? EMPTY
function set(nodeId: string, next: MutateUi): void {
  if (next.confirm === null && next.toasts.length === 0) state.delete(nodeId)
  else state.set(nodeId, next)
  emit()
}

/** Snapshot UI mutate sebuah node; referensi stabil sampai ada perubahan. */
export function useMutateUi(nodeId: string): MutateUi {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => get(nodeId),
  )
}

/** Pasang/lepas dialog konfirmasi hapus. */
export function setConfirm(nodeId: string, confirm: Confirm | null): void {
  if (confirm === null && get(nodeId).confirm === null) return
  set(nodeId, { ...get(nodeId), confirm })
}
export function pushToast(nodeId: string, toast: Omit<Toast, 'id'>): string {
  const id = `toast-${nodeId}-${++seq}`
  set(nodeId, { ...get(nodeId), toasts: [...get(nodeId).toasts, { ...toast, id }] })
  return id
}
export function dismissToast(nodeId: string, id: string): void {
  const cur = get(nodeId)
  if (cur.toasts.some((t) => t.id === id)) set(nodeId, { ...cur, toasts: cur.toasts.filter((t) => t.id !== id) })
}
/** Buang semua state sebuah node (node dilepas). */
export function clearUi(nodeId: string): void {
  if (state.delete(nodeId)) emit()
}
