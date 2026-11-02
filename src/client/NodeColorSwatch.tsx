import { useState } from 'react'
import { Button } from '@/components/ui/button'

export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']

export interface NodeColorSwatchProps {
  color: string
  onColor: (c: string) => void
}

export default function NodeColorSwatch({ color, onColor }: NodeColorSwatchProps) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <Button
        variant="ghost" size="icon-xs"
        className="nodrag node-swatch size-3 rounded-full border-0 p-0 hover:bg-transparent dark:hover:bg-transparent"
        title="Color" style={{ background: color }} onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <span className="node-swatch-pop">
          {NODE_COLORS.map((c) => (
            <Button
              key={c}
              variant="ghost" size="icon-xs"
              className="nodrag node-swatch size-3 rounded-full border-0 p-0 hover:bg-transparent dark:hover:bg-transparent"
              title={c}
              style={{ background: c }}
              onClick={() => { onColor(c); setOpen(false) }}
            />
          ))}
        </span>
      )}
    </span>
  )
}
