// What the header hands to the rail (docs/decisions/header-rail-layout.md): the menu button at the top, Account in
// the bottom group, and (Hidden only) the layout switch. They reuse the header's own parts (`useWorkspaceMenus`,
// `AccountMenu`, `LayoutToggle`), so a control has one implementation. Nothing here reads whether the app runs in a
// browser or natively.
import { AccountMenu } from './AccountMenu'
import { AppMenuButton } from './AppMenuButton'
import { LayoutToggle } from './WorkspaceBar'
import { useWorkspaceMenus, type WorkspaceMenuProps } from './useWorkspaceMenus'

export interface RailChromeProps extends WorkspaceMenuProps {
  /** Hidden has no tab row, so the layout switch is a rail button there (Tabs keeps it in the row). */
  layoutInRail: boolean
  layoutMode?: 'canvas' | 'tabs'
}

/** Top of the rail: one hamburger, the same File / View / Help model as everywhere. Lone Alt focuses it. */
export function RailMenu(p: RailChromeProps) {
  return <AppMenuButton menus={useWorkspaceMenus(p)} variant="rail" />
}

/** Bottom group, above Settings: only with an account to show (same condition as the tab row's account button). */
export function RailAccount({ showLogout, onOpenAccount, onOpenSettings, onOpenHelp }: RailChromeProps) {
  return showLogout ? <AccountMenu variant="rail" onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} /> : null
}

/** Bottom group, Hidden only: the board layout switch (absent without a workspace to switch). */
export function RailLayout({ layoutInRail, layoutMode, onToggleLayout, activeId }: RailChromeProps) {
  return layoutInRail && onToggleLayout && activeId ? <LayoutToggle variant="rail" layoutMode={layoutMode} onToggle={onToggleLayout} /> : null
}
