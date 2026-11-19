// Rows of the canvas browser's own context menu. Pure: the caller passes what each action does. Every row acts inside
// the canvas (a tab of this node, the clipboard, the page itself); "Open in system browser" is deliberately NOT here: the
// only way out is the explicit action in the toolbar's menu (docs/decisions/canvas-containment.md).
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import type { ContextInfo } from '../../shared/browser.contextmenu'

export interface ContextMenuDeps {
  canBack: boolean
  canForward: boolean
  nav: (action: 'back' | 'forward' | 'reload') => void
  /** Open the address as a tab of this node (the server checks it again). */
  openLink: (url: string) => void
  copyText: (text: string) => void
  /** Copy the page's current selection (the server reads it, the client writes the clipboard). */
  copySelection: () => void
  cut: () => void
  paste: () => void
}

const item = (id: string, label: string, onSelect: () => void, disabled = false): VscodeMenuItem => ({ type: 'item', id, label, disabled, onSelect })

/** Link, image, selection and editing rows first (as in Chrome), then the page rows. */
export function contextMenuItems(info: ContextInfo, d: ContextMenuDeps): VscodeMenuItem[] {
  const rows: VscodeMenuItem[][] = []
  if (info.link) {
    const { href } = info.link
    rows.push([item('open-link', 'Open link in new tab', () => d.openLink(href)), item('copy-link', 'Copy link address', () => d.copyText(href))])
  }
  if (info.image) {
    const src = info.image
    rows.push([item('copy-image', 'Copy image address', () => d.copyText(src))])
  }
  if (info.editable) rows.push([item('cut', 'Cut', d.cut, !info.selection), item('copy', 'Copy', d.copySelection, !info.selection), item('paste', 'Paste', d.paste)])
  else if (info.selection) rows.push([item('copy', 'Copy', d.copySelection)])
  rows.push([item('back', 'Back', () => d.nav('back'), !d.canBack), item('forward', 'Forward', () => d.nav('forward'), !d.canForward), item('reload', 'Reload', () => d.nav('reload'))])
  return rows.flatMap((r, i) => (i === 0 ? r : [{ type: 'separator' as const }, ...r]))
}
