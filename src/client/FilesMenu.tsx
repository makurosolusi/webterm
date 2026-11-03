// Menu konteks node files: grup dipisah separator, ada shortcut, dan baris dari slot disisipkan
// tanpa FilesMenu tahu isinya. Memakai `VscodeMenu` langsung (bukan NodeContextMenu) karena yang itu
// belum mendukung `keybinding`.
import type { ReactNode } from 'react'
import type { FileMeta } from '../shared/fsContract'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'
import type { SlotMenuRow } from './filesSlots'

/** Ikon codicon dekoratif (CSS codicon dimuat shell). */
export const codicon = (name: string): ReactNode => <span className={`codicon codicon-${name}`} aria-hidden="true" />

export interface FilesMenuActions {
  open(entry: FileMeta): void
  terminal(): void
  newEntry(dir: boolean): void
  refresh(): void
  reveal(entry: FileMeta): void
  copyPath(relative: boolean): void
}

interface Props {
  x: number
  y: number
  entry: FileMeta | null
  /** Baris dari `FILES_SLOTS[*].menu`; satu grup, dipisah dari grup bawaan. */
  slotRows: SlotMenuRow[]
  actions: FilesMenuActions
  onClose: () => void
}

const item = (label: string, icon: string, onSelect: () => void, keybinding?: string): VscodeMenuItem =>
  ({ type: 'item', id: label, label, icon: codicon(icon), keybinding, onSelect })

/** Ubah baris slot ke item menu; separator di dalam slot dipertahankan. */
function fromSlot(rows: SlotMenuRow[], group: number): VscodeMenuItem[] {
  return rows.map((r, i): VscodeMenuItem => 'type' in r
    ? { type: 'separator' }
    : { type: 'item', id: `slot${group}-${i}-${r.label}`, label: r.label, icon: r.icon, disabled: r.disabled, danger: r.danger, title: r.hint, keybinding: r.keybinding, onSelect: r.onClick })
}

/** Sambung grup dengan satu separator di antaranya; grup kosong dilewati (tanpa separator ganda). */
export function joinGroups(groups: VscodeMenuItem[][]): VscodeMenuItem[] {
  return groups.filter((g) => g.length > 0).flatMap((g, i) => (i === 0 ? g : [{ type: 'separator' } as VscodeMenuItem, ...g]))
}

export function buildMenuItems(entry: FileMeta | null, slotRows: SlotMenuRow[], a: FilesMenuActions): VscodeMenuItem[] {
  return joinGroups([
    entry ? [item('Open', entry.dir ? 'folder' : 'file', () => a.open(entry), 'Enter')] : [],
    [item('Open in Integrated Terminal', 'terminal', a.terminal)],
    [item('New File…', 'new-file', () => a.newEntry(false)), item('New Folder…', 'new-folder', () => a.newEntry(true))],
    fromSlot(slotRows, 0),
    [
      ...(entry ? [item('Reveal', 'eye', () => a.reveal(entry))] : []),
      item('Refresh', 'refresh', a.refresh),
    ],
    [item('Copy Path', 'copy', () => a.copyPath(false), '⌥⌘C'), item('Copy Relative Path', 'copy', () => a.copyPath(true), '⇧⌥⌘C')],
  ])
}

export default function FilesMenu({ x, y, entry, slotRows, actions, onClose }: Props) {
  return (
    <VscodeMenu open anchor={{ x, y }} items={buildMenuItems(entry, slotRows, actions)} onClose={onClose} ariaLabel="File actions" />
  )
}
