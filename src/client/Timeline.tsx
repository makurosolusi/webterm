// Activity timeline in the bottom panel (PLAN F1-e): every recorded signal as one readable line,
// grouped by task / node / workspace, filterable, click to jump to the node. Grouping and wording
// live in ./Timeline.model; the live feed in ./Timeline.stream; level + integrity in ./Timeline.status.
import { lazy, Suspense, useSyncExternalStore } from 'react'
import type { Workspace, WsNode } from '../shared/workspace'
import { useRegisterCommands, type Command } from './commandRegistry'
import { toggleBottomView, type BottomPanelView } from './bottomPanelHost'

// The panel body loads when the Activity tab first shows (closed by default); the store and command stay here.
const TimelinePanel = lazy(() => import('./Timeline.panel').then((m) => ({ default: m.TimelinePanel })))

/** localStorage key for the open state. */
export const TIMELINE_OPEN_KEY = 'webterm.timelineOpen'

/* --- Open state: one module store so the palette command and the panel share it ---------------- */

const listeners = new Set<() => void>()
let open = ((): boolean => { try { return localStorage.getItem(TIMELINE_OPEN_KEY) === '1' } catch { return false } })()
/** Opens or closes the Activity panel (persisted per browser). */
export function setTimelineOpen(next: boolean): void {
  open = next
  try { localStorage.setItem(TIMELINE_OPEN_KEY, next ? '1' : '0') } catch { /* private mode: this tab only */ }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const useTimelineOpen = (): boolean => useSyncExternalStore(subscribe, () => open, () => open)

/** Dock/palette/status-bar toggle: opens, reveals behind another tab, or closes when shown. */
export const toggleTimeline = (): void => toggleBottomView('activity', open, setTimelineOpen)

const COMMANDS: Command[] = [{ id: 'view.toggleActivity', label: 'View: Toggle Activity', run: toggleTimeline }]

/* --- Panel ------------------------------------------------------------------------------------------ */

export interface TimelinePanelProps {
  workspaces: readonly Workspace[]
  /** Nodes of the active board (fresher titles than the saved snapshot). */
  liveNodes?: readonly WsNode[]
  activeId?: string | null
  onFocusNode: (id: string) => void
}

/** Activity as a tab of the bottom panel (see App.bottomPanel). The toolbar lives in the body, so no actions slot. */
export function useTimelineView(props: TimelinePanelProps): BottomPanelView {
  return {
    id: 'activity', label: 'Activity', tooltip: 'Activity', open: useTimelineOpen(), onClose: () => setTimelineOpen(false),
    render: () => <Suspense fallback={null}><TimelinePanel {...props} /></Suspense>,
  }
}

/** Always-mounted: registers "View: Toggle Activity"; the panel itself is a BottomPanelHost view. */
export default function TimelineHost(): null {
  useRegisterCommands(COMMANDS)
  return null
}
