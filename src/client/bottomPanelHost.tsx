// The single VS Code bottom panel: one surface, a tab per open view (Inbox, Chat, Problems,
// Output), exactly one view shown. Opening a view selects its tab instead of stacking another
// surface on top. Views stay mounted while open (hidden when inactive) so switching tabs never
// restarts a fetch, drops an approval dialog, or reopens a stream.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { InboxPanelSurface } from './inboxPanelSurface'

export interface BottomPanelView {
  id: string
  label: string
  tooltip?: string
  /** Count shown in the tab badge. */
  badge?: number
  open: boolean
  /** Closes this view (tab close, Escape inside the view). */
  onClose: () => void
  /** Pane body; `actionsHost` is the toolbar slot while this view is the active one, else null. */
  render: (actionsHost: HTMLElement | null) => ReactNode
}

let activeId: string | null = null
const listeners = new Set<() => void>()

/** Select a view's tab (also used by the Dock when the view is open behind another tab). */
export function revealBottomView(id: string | null): void {
  activeId = id
  listeners.forEach((listener) => listener())
}

/** Dock toggle with VS Code semantics: closed opens, open-but-hidden reveals, shown closes. */
export function toggleBottomView(id: string, open: boolean, setOpen: (open: boolean) => void): void {
  if (open && activeId !== id) revealBottomView(id)
  else setOpen(!open)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export default function BottomPanelHost({ views }: { views: BottomPanelView[] }): React.JSX.Element | null {
  const stored = useSyncExternalStore(subscribe, () => activeId)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const open = views.filter((view) => view.open)
  const openKey = open.map((view) => view.id).join('|')
  const seen = useRef(openKey)

  const shown = open.find((view) => view.id === stored)?.id ?? open[0]?.id ?? null
  // A view that just opened takes the tab; otherwise publish the fallback so `toggleBottomView`
  // knows which tab is really showing.
  useEffect(() => {
    const before = seen.current === '' ? [] : seen.current.split('|')
    seen.current = openKey
    const added = open.filter((view) => !before.includes(view.id)).pop()
    if (added) revealBottomView(added.id)
    else if (shown !== null && shown !== stored) revealBottomView(shown)
  }, [openKey, shown, stored])

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
