// Shared UI state of the workspace tab surfaces: tab context menu, `+` menu, inline rename, color picker.
// One module store (not component state) because two surfaces drive the same hosts: the header's tab
// strip (Full) and the rail tiles (Compact/Hidden) both open the menu that `WorkspaceBarHosts` renders,
// and File > Rename edits whichever surface is on screen. There is one app instance per page.
import { useSyncExternalStore } from 'react'

export interface PointAt {
  x: number
  y: number
}

export interface WorkspaceTabUi {
  /** Tab/tile context menu: which workspace it acts on (not necessarily the active one) and where. */
  menu: ({ id: string } & PointAt) | null
  addMenu: PointAt | null
  editingId: string | null
  colorId: string | null
}

const INITIAL: WorkspaceTabUi = { menu: null, addMenu: null, editingId: null, colorId: null }
let state: WorkspaceTabUi = INITIAL
const listeners = new Set<() => void>()

function patch(next: Partial<WorkspaceTabUi>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export const setTabMenu = (menu: WorkspaceTabUi['menu']): void => patch({ menu })
export const setAddMenu = (addMenu: PointAt | null): void => patch({ addMenu })
export const setEditingId = (editingId: string | null): void => patch({ editingId })
export const setColorId = (colorId: string | null): void => patch({ colorId })

/** Test seam: back to the initial (everything closed) state. */
export function resetWorkspaceTabUi(): void {
  state = INITIAL
  for (const l of listeners) l()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export const useWorkspaceTabUi = (): WorkspaceTabUi => useSyncExternalStore(subscribe, () => state)
