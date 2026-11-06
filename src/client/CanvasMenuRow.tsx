// Penerjemah baris model menu canvas (`canvasMenu.model.ts`, data murni) ke `VscodeMenuItem`.
// Semua perilaku menu (portal, penempatan, keyboard, submenu) dimiliki `VscodeMenu`; file ini hanya
// memutuskan ikon codicon, titik warna agent, dan tooltip alasan untuk tiap baris.
import type { CSSProperties } from 'react'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { isSeparator } from './canvasMenu.model'
import type { CanvasMenuIcon, CanvasMenuItem, CanvasMenuRow } from './canvasMenu.model'

const ICON_NAMES: Record<CanvasMenuIcon, string> = {
  terminal: 'terminal',
  agent: 'hubot',
  agentChat: 'comment-discussion',
  files: 'files',
  browser: 'globe',
  diff: 'git-compare',
  'select-all': 'selection',
  fit: 'screen-full',
}

/** Ikon baris: titik warna untuk agent, selain itu codicon. */
function RowIcon({ item }: { item: CanvasMenuItem }) {
  if (item.dot) {
    return <span className="vscode-menu__dot" style={{ '--vscode-menu-dot-color': item.dot } as CSSProperties} />
  }
  return <span className={`codicon codicon-${ICON_NAMES[item.icon]}`} />
}

function toItem(item: CanvasMenuItem): VscodeMenuItem {
  return {
    type: 'item',
    id: item.key,
    label: item.label,
    icon: <RowIcon item={item} />,
    title: item.hint,
    disabled: item.disabled,
    onSelect: item.onClick,
    submenu: item.children?.map(toItem),
  }
}

/** Baris model menu canvas sebagai item `VscodeMenu`; separator tetap separator. */
export function toVscodeMenuItems(rows: CanvasMenuRow[]): VscodeMenuItem[] {
  return rows.map((row) => (isSeparator(row) ? { type: 'separator' } : toItem(row)))
}
