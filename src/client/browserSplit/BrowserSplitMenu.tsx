// "Split" button of the node header: split the focused pane right/down, one-tap layouts (2 columns, 2 rows, 2x2) and the
// QC shortcut "Open this page in 3 sizes". Rows that cannot run say why (pane limit, node too small) instead of hiding.
import { useState } from 'react'
import { Columns2 } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { chordLabel } from '@/commandRegistry'
import { isMacPlatform } from '@/terminalKeys'
import { MAX_PANES } from '../../shared/browser.layout'
import type { SplitControls } from './useBrowserSplit'

/** Rows of the split menu; shared with tests. */
export function splitMenuItems(c: SplitControls): VscodeMenuItem[] {
  const target = c.focusId
  const right = target ? c.canSplitAt(target, 'right') : { ok: false as const, reason: 'No page to split' }
  const down = target ? c.canSplitAt(target, 'bottom') : { ok: false as const, reason: 'No page to split' }
  const row = (id: string, label: string, run: () => void, blocked?: string, keybinding?: string): VscodeMenuItem =>
    ({ type: 'item', id, label, keybinding, disabled: blocked !== undefined, title: blocked, onSelect: run })
  return [
    row('right', 'Split right', () => { void c.split('right') }, right.ok ? undefined : right.reason, chordLabel('Mod+\\', isMacPlatform())),
    row('down', 'Split down', () => { void c.split('bottom') }, down.ok ? undefined : down.reason),
    { type: 'separator' },
    row('columns', '2 columns', () => { void c.preset('columns') }),
    row('rows', '2 rows', () => { void c.preset('rows') }),
    row('grid', `2 × 2 grid (${MAX_PANES} panes)`, () => { void c.preset('grid') }),
    { type: 'separator' },
    row('sizes', 'Open this page in 3 sizes', () => { void c.openInSizes() }),
    ...(c.layout ? [{ type: 'separator' } as const, row('unsplit', 'Unsplit (one pane)', () => { void c.unsplit() })] : []),
  ]
}

export function BrowserSplitMenu({ controls }: { controls: SplitControls }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const panes = controls.shown.length
  return (
    <>
      <IconButton
        label={`Split view (${panes}/${MAX_PANES} panes)`} size="icon-bui" aria-haspopup="menu" aria-expanded={at !== null} data-split-button
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom }) }}
      >
        <Columns2 aria-hidden="true" />
      </IconButton>
      {at && <VscodeMenu open anchor={at} items={splitMenuItems(controls)} onClose={() => setAt(null)} ariaLabel="Split view" />}
    </>
  )
}
