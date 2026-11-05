// "+" button of the tab strip: Orca's static create menu (New Terminal / Browser ...) adapted to the
// node kinds webterm can spawn. Opens the shared VscodeMenu under the button.
import { useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { codicon } from './dockCodicon'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'

export interface NewTabMenuProps {
  onAddTerminal: () => void
  onAddAgent: () => void
  onAddBrowser?: () => void
  onAddDiff: () => void
  onAddFiles: () => void
}

export default function NewTabMenu(p: NewTabMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const row = (id: string, label: string, icon: string, onSelect: () => void): VscodeMenuItem =>
    ({ type: 'item', id, label, icon: codicon(icon), onSelect })
  const items: VscodeMenuItem[] = [
    row('terminal', 'New Terminal', 'terminal', p.onAddTerminal),
    row('agent', 'New Agent', 'hubot', p.onAddAgent),
    ...(p.onAddBrowser ? [row('browser', 'New Browser', 'globe', p.onAddBrowser)] : []),
    row('diff', 'New Changes', 'git-compare', p.onAddDiff),
    { type: 'separator' },
    row('files', 'New Files', 'folder', p.onAddFiles),
  ]
  return (
    <>
      <IconButton
        label="New tab" side="bottom" size="icon-sm" aria-haspopup="menu" aria-expanded={at !== null}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom }) }}
      ><span className="codicon codicon-add" aria-hidden="true" /></IconButton>
      {at && <VscodeMenu open anchor={at} items={items} onClose={() => setAt(null)} ariaLabel="New tab" />}
    </>
  )
}
