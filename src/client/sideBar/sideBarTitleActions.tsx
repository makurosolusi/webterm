// The view-title toolbar of the side bar (VS Code puts a view's own actions, e.g. Collapse All, in
// its title row, not in the body). SideBar provides the slot element; a view portals its buttons
// there. Outside a SideBar (a view rendered on its own) the actions render in place.
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const SideBarTitleSlot = createContext<HTMLElement | null>(null)

/** Renders `children` in the side bar's title toolbar, or in place when there is none. */
export function SideBarTitleActions({ children }: { children: ReactNode }) {
  const slot = useContext(SideBarTitleSlot)
  return slot ? createPortal(children, slot) : <>{children}</>
}
