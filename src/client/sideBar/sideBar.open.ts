// Opens a side bar view from anywhere (the Control > Skills pointer): a window event that `useAppSideBar` answers by
// showing the view. Unlike the activity icon it never toggles an already shown view closed.
import { useEffect } from 'react'
import { SIDE_BAR_VIEWS, type SideBarView } from './sideBar.view'

export const OPEN_SIDE_BAR_VIEW = 'webterm:open-side-bar-view'

export const openSideBarView = (view: SideBarView): void => {
  window.dispatchEvent(new CustomEvent(OPEN_SIDE_BAR_VIEW, { detail: { view } }))
}

/** Calls `show` for every `openSideBarView` request while mounted. */
export function useOpenSideBarRequests(show: (view: SideBarView) => void): void {
  useEffect(() => {
    const h = (e: Event): void => {
      const view = (e as CustomEvent<{ view?: SideBarView }>).detail?.view
      if (view && SIDE_BAR_VIEWS.includes(view)) show(view)
    }
    window.addEventListener(OPEN_SIDE_BAR_VIEW, h)
    return () => window.removeEventListener(OPEN_SIDE_BAR_VIEW, h)
  }, [show])
}
