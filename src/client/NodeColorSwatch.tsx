import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ToolbarButton } from '@/vscode/register'

export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']

export interface NodeColorSwatchProps {
  color: string
  onColor: (c: string) => void
}

/** Titik warna node di header; klik membuka grid swatch kecil (Esc atau klik di luar menutupnya). */
export default function NodeColorSwatch({ color, onColor }: NodeColorSwatchProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Capture: React Flow menghentikan propagasi pointer di kanvas, listener bubble tak akan sampai.
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="relative inline-flex" ref={rootRef}>
      <ToolbarButton
        className="nodrag" label="Color" title="Color" data-title="Color"
        toggleable checked={open} onClick={() => setOpen((o) => !o)}
      ><span className="node-swatch__dot" style={{ '--swatch': color } as CSSProperties} /></ToolbarButton>
      {open && (
        <span className="node-swatch-pop" role="group" aria-label="Node color">
          {NODE_COLORS.map((c) => (
            <button
              key={c} type="button"
              className="nodrag node-swatch"
              title={c} aria-label={c} aria-pressed={c.toLowerCase() === color.toLowerCase()}
              style={{ '--swatch': c } as CSSProperties}
              onClick={() => { onColor(c); setOpen(false) }}
            />
          ))}
        </span>
      )}
    </span>
  )
}
