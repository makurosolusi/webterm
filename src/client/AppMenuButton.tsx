// The compact menu: one button at the top of the rail that opens File / View / Help as submenus (VS Code's
// "compact menu" pattern), used where the full menu bar is not drawn. Same menu model as the bar: this only wraps
// the model's menus as submenus of a single top-level entry, so no menu logic is duplicated.
import { useMemo } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { VscodeMenuBar } from '@/components/vscode/vscodeMenuBar'
import type { VscodeMenu } from '@/components/vscode/vscodeMenuBar'

/** Id of the single top-level entry; the open state the owner keeps while it is open. */
export const APP_MENU_ID = 'app'

export interface AppMenuButtonProps {
  /** The File / View / Help model (`buildWorkspaceMenus`). */
  menus: VscodeMenu[]
  openId: string | null
  onOpenChange: (id: string | null) => void
}

export function AppMenuButton({ menus, openId, onOpenChange }: AppMenuButtonProps) {
  const compact = useMemo<VscodeMenu[]>(
    () => [{ id: APP_MENU_ID, label: 'Menu', items: menus.map((m) => ({ id: m.id, label: m.label, submenu: m.items })) }],
    [menus],
  )
  return (
    <IconTooltip label="Menu: File, View and Help" side="right">
      <span className="app-menu-button">
        <VscodeMenuBar menus={compact} openId={openId} onOpenChange={onOpenChange} />
      </span>
    </IconTooltip>
  )
}
