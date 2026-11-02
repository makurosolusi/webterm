import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ToolbarButton } from '@/vscode/register'
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
      <ToolbarButton
        className="nodrag" label="Color" title="Color" data-title="Color"
        toggleable checked={open} onClick={() => setOpen((o) => !o)}
      ><span className="node-swatch__dot" style={{ '--swatch': color } as CSSProperties} /></ToolbarButton>
      {open && rootRef.current && (
        // Popover portal ke body: tidak ter-clip `.term-node` (overflow hidden) dan tidak ikut zoom canvas;
        // Esc / klik di luar ditangani primitifnya.
        <VscodePopover anchor={rootRef.current} open onOpenChange={setOpen} ariaLabel="Node color" className="node-swatch-pop">
          <div role="group" aria-label="Node color" className="node-swatch-grid">
            {NODE_COLORS.map((c) => (
              <button
                key={c} type="button"
                className="nodrag node-swatch"
                title={c} aria-label={c} aria-pressed={c.toLowerCase() === color.toLowerCase()}
                style={{ '--swatch': c } as CSSProperties}
                onClick={() => { onColor(c); setOpen(false) }}
              />
            ))}
          </div>
        </VscodePopover>
      )}
    </span>
  )
}
