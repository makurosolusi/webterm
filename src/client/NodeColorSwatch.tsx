import type { CSSProperties } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { VscodePopover } from './components/vscode/vscodePopover'

export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']

/** Menu label that opens the picker (the colour itself is only a thin accent on the header edge). */
export const NODE_COLOR_MENU_LABEL = 'Node color…'

export interface NodeColorPickerProps {
  anchor: HTMLElement
  color: string
  onColor: (c: string) => void
  onClose: () => void
}

/**
 * Grid of node colours, opened from the node's "…" menu (VS Code: tab colour lives in a menu, not a
 * coloured button next to the title, so it never reads as a status light).
 */
export default function NodeColorPicker({ anchor, color, onColor, onClose }: NodeColorPickerProps) {
  return (
    // Portal to body: not clipped by `.term-node` (overflow hidden) and not zoomed with the canvas;
    // Esc / a press outside is handled by the primitive.
    <VscodePopover anchor={anchor} open onOpenChange={(o) => { if (!o) onClose() }} ariaLabel="Node color" className="node-swatch-pop">
      <div role="group" aria-label="Node color" className="node-swatch-grid">
        {NODE_COLORS.map((c) => {
          const current = c.toLowerCase() === color.toLowerCase()
          return (
            <IconTooltip key={c} label={current ? `${c} (current color)` : `Set node color to ${c}`}>
              <button
                type="button"
                className="nodrag node-swatch"
                aria-label={c} aria-pressed={current}
                style={{ '--swatch': c } as CSSProperties}
                onClick={() => { onColor(c); onClose() }}
              />
            </IconTooltip>
          )
        })}
      </div>
    </VscodePopover>
  )
}
