import { createElement, lazy, Suspense, useSyncExternalStore } from 'react'
import { toggleBottomView, useShownBottomView, type BottomPanelView } from '../../bottomPanelHost'
import { useRegisterCommands, type Command } from '../../commandRegistry'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { TL } from './taskBoardLabels'

const TaskBoard = lazy(() => import('./TaskBoard'))

/** Bottom panel view id of the task board. */
export const TASK_BOARD_VIEW_ID = 'tasks'
/** localStorage key for the open state. */
export const TASK_BOARD_OPEN_KEY = 'webterm.taskBoardOpen'

function readOpen(): boolean {
  try {
    return localStorage.getItem(TASK_BOARD_OPEN_KEY) === '1'
  } catch (err) {
    console.warn('task board: reading the open state failed', err)
    return false
  }
}

const listeners = new Set<() => void>()
let open = readOpen()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Opens or closes the Tasks tab (persisted per browser). */
export function setTaskBoardOpen(next: boolean): void {
  open = next
  try {
    localStorage.setItem(TASK_BOARD_OPEN_KEY, next ? '1' : '0')
  } catch (err) {
    console.warn('task board: saving the open state failed', err)
  }
  listeners.forEach((l) => l())
}

/** Palette and status-bar toggle: opens, reveals behind another tab, or closes when shown. */
export const toggleTaskBoard = (): void => toggleBottomView(TASK_BOARD_VIEW_ID, open, setTaskBoardOpen)

/** Status bar entry for the board; App shows it only while Central is on. */
export const TASK_BOARD_STATUS_ITEM: VscodeStatusItem = {
  id: TASK_BOARD_VIEW_ID, label: TL.tab, icon: createElement('span', { className: 'codicon codicon-checklist', 'aria-hidden': true }),
  tooltip: TL.toggleTooltip, ariaLabel: TL.toggleTooltip, onClick: toggleTaskBoard,
}

const COMMANDS: Command[] = [{ id: 'view.toggleTasks', label: TL.toggleCommand, run: toggleTaskBoard }]
const NO_COMMANDS: Command[] = []

/** The Tasks tab of the bottom panel; exists only while Central is on. */
export function useTaskBoardView(centralEnabled: boolean): BottomPanelView {
  useRegisterCommands(centralEnabled ? COMMANDS : NO_COMMANDS)
  const isOpen = useSyncExternalStore(subscribe, () => open, () => open)
  const shown = useShownBottomView() === TASK_BOARD_VIEW_ID
  return {
    id: TASK_BOARD_VIEW_ID, label: TL.tab, tooltip: TL.tab, open: isOpen && centralEnabled, onClose: () => setTaskBoardOpen(false),
    render: () => <Suspense fallback={null}><TaskBoard visible={shown} /></Suspense>,
  }
}
