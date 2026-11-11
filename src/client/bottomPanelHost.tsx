// The single VS Code bottom panel: one surface, a tab per open view (Problems,
// Activity, Output), exactly one view shown. Opening a view selects its tab instead of stacking another
// surface on top. Views stay mounted while open (hidden when inactive) so switching tabs never
// restarts a fetch, drops an approval dialog, or reopens a stream.
//
// Under the app router the shown tab is the URL's `?panel=` (./appRoute): App passes it as `panel`,
// and `revealBottomView` writes it. The per-view open flags stay with their views: they say which
// tabs exist (several can), not which one shows. Without a router (component tests) a module store
// stands in for the URL.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { InboxPanelSurface } from './inboxPanelSurface'
import { appNavigate, BOTTOM_PANEL_ROUTE_IDS, type BottomPanelRouteId } from './appRoute'

export interface BottomPanelView {
  id: string
  label: string
  tooltip?: string
  /** Count shown in the tab badge. */
  badge?: number
  open: boolean
  /** Closes this view (tab close, Escape inside the view). */
  onClose: () => void
  /** Opens this view; called when the URL asks for it (reload, Back/Forward, a link). */
  onOpen?: () => void
  /** Pane body; `actionsHost` is the toolbar slot while this view is the active one, else null. */
  render: (actionsHost: HTMLElement | null) => ReactNode
}

let activeId: string | null = null
let shownId: string | null = null
const listeners = new Set<() => void>()

const isRouteId = (id: string): id is BottomPanelRouteId => (BOTTOM_PANEL_ROUTE_IDS as readonly string[]).includes(id)

/** Select a view's tab (also used by the Dock when the view is open behind another tab). `replace`
 *  records a tab already on screen without a Back step. */
export function revealBottomView(id: string | null, opts?: { replace?: boolean }): void {
  const nav = appNavigate()
  if (nav && (id === null || isRouteId(id))) {
    nav.setPanel(id, opts)
    return
  }
  activeId = id
  listeners.forEach((listener) => listener())
}

/** Dock toggle with VS Code semantics: closed opens, open-but-hidden reveals, shown closes. */
export function toggleBottomView(id: string, open: boolean, setOpen: (open: boolean) => void): void {
  if (open && shownId !== null && shownId !== id) revealBottomView(id)
  else setOpen(!open)
}

function publishShown(id: string | null): void {
  if (shownId === id) return
  shownId = id
  listeners.forEach((listener) => listener())
}

/** Id of the tab the panel is showing right now; null when no panel is up (open-but-hidden views are not shown). */
export function useShownBottomView(): string | null {
  return useSyncExternalStore(subscribe, () => shownId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** `panel`: the URL's `?panel=` (App); omitted, the module store is used instead. */
export default function BottomPanelHost({ views, panel }: { views: BottomPanelView[]; panel?: string | null }): React.JSX.Element | null {
  const own = useSyncExternalStore(subscribe, () => activeId)
  const stored = panel === undefined ? own : panel
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const open = views.filter((view) => view.open)
  const openKey = open.map((view) => view.id).join('|')
  // `stored: null` at first so a `?panel=` present at mount counts as a request and opens its view.
  const seen = useRef<{ openKey: string; stored: string | null }>({ openKey, stored: null })

  const shown = open.find((view) => view.id === stored)?.id ?? open[0]?.id ?? null
  useEffect(() => {
    const before = seen.current.openKey === '' ? [] : seen.current.openKey.split('|')
    const wasStored = seen.current.stored
    seen.current = { openKey, stored }
    if (stored !== wasStored) {
      // The URL moved (reload, Back/Forward, a link): show what it names; no tab named = the panel closes.
      if (stored === null) open.forEach((view) => view.onClose())
      else views.find((view) => view.id === stored && !view.open)?.onOpen?.()
      return
    }
    const added = open.filter((view) => !before.includes(view.id)).pop()
    // A view that just opened takes the tab.
    if (added) revealBottomView(added.id)
    // The shown tab closed: the next one (or none) takes the URL.
    else if (stored !== null && before.includes(stored) && !open.some((view) => view.id === stored)) revealBottomView(shown)
    // Tabs restored at boot (open flags persisted) without a `?panel=`: record the shown one silently.
    else if (stored === null && shown !== null) revealBottomView(shown, { replace: true })
  }, [openKey, shown, stored])

  useEffect(() => {
    publishShown(shown)
    return () => publishShown(null)
  }, [shown])

  if (shown === null) return null
  const byId = (id: string): BottomPanelView | undefined => open.find((view) => view.id === id)

  return (
    <InboxPanelSurface
      className="bottom-panel-host"
      ariaLabel="Panel"
      tabs={open.map(({ id, label, tooltip, badge }) => ({
        id, label, ...(tooltip === undefined ? {} : { tooltip }), ...(badge === undefined ? {} : { badge }),
      }))}
      activeId={shown}
      onActivate={revealBottomView}
      onClose={(id) => byId(id)?.onClose()}
      onClosePanel={() => open.forEach((view) => view.onClose())}
      actionsSlotRef={setSlot}
    >
      {open.map((view) => (
        <div key={view.id} className="vscode-bottom-panel__pane" hidden={view.id !== shown}>
          {view.render(view.id === shown ? slot : null)}
        </div>
      ))}
    </InboxPanelSurface>
  )
}
