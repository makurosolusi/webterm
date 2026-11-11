// The Central side bar's side of the URL contract (./appRoute): `?ctab=<tab>` is present exactly while
// the side bar shows the Central control panel, and names its tab. Whether the side bar is open (and
// on which view) stays in `secondarySideBar.store` (localStorage); this only keeps the two in step.
import { useEffect, useRef } from 'react'
import { setSideBar, useSideBar } from './secondarySideBar.store'
import type { AppRouteActions, CentralRouteTab } from './appRoute'

/**
 * Each effect reacts to ONE side, so they never fight:
 * - URL: a `ctab` shows the Central view (reload, Forward, a link); `ctab` removed while Central is shown
 *   (Back) closes the side bar.
 * - Side bar: Central shown without a `ctab` writes `status` (push after a click, replace at boot so a
 *   restored side bar adds no Back step); leaving Central (close, switch to Chat) drops the `ctab`.
 */
export function useCentralTabUrlSync(ctab: CentralRouteTab | null, setCentralTab: AppRouteActions['setCentralTab'], centralEnabled: boolean): void {
  const { open, view } = useSideBar()
  // Central off: the side bar shows Chat even on the `central` view, so there is no tab to name.
  const showing = open && view === 'central' && centralEnabled
  const latest = useRef({ ctab, showing })
  latest.current = { ctab, showing }
  const prevTab = useRef(ctab)
  const prevShowing = useRef<boolean | null>(null) // null = first run (boot)

  useEffect(() => {
    const was = prevTab.current
    prevTab.current = ctab
    if (ctab && !latest.current.showing) setSideBar({ open: true, view: 'central' })
    else if (!ctab && was && latest.current.showing) setSideBar({ open: false })
  }, [ctab])

  useEffect(() => {
    const was = prevShowing.current
    prevShowing.current = showing
    const tab = latest.current.ctab
    if (showing && was !== true && !tab) setCentralTab('status', { replace: was === null })
    else if (!showing && was === true && tab) setCentralTab(null)
  }, [showing, setCentralTab])
}
