import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ToolbarButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import { VscodePopover } from './components/vscode/vscodePopover'

export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']

export interface NodeColorSwatchProps {
  color: string
  onColor: (c: string) => void
}

/** Titik warna node di header (penanda tab, bukan border); klik membuka popover grid swatch kecil. */
export default function NodeColorSwatch({ color, onColor }: NodeColorSwatchProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  return (
    <span className="relative inline-flex" ref={rootRef}>
      <IconTooltip label={open ? 'Node color: picker open, click to close it' : 'Node color: click to choose one'}>
        <ToolbarButton
          className="nodrag" label="Color" data-title="Color"
          toggleable checked={open} onClick={() => setOpen((o) => !o)}
        ><span className="node-swatch__dot" style={{ '--swatch': color } as CSSProperties} /></ToolbarButton>
      </IconTooltip>
      {open && rootRef.current && (
        // Popover portal ke body: tidak ter-clip `.term-node` (overflow hidden) dan tidak ikut zoom canvas;
        // Esc / klik di luar ditangani primitifnya.
        <VscodePopover anchor={rootRef.current} open onOpenChange={setOpen} ariaLabel="Node color" className="node-swatch-pop">
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
                    onClick={() => { onColor(c); setOpen(false) }}
                  />
                </IconTooltip>
              )
            })}
          </div>
        </VscodePopover>
      )}
    </span>
  )
}
