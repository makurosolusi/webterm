import { useState } from 'react'

export const NODE_COLORS = ['#0a84ff', '#d97757', '#10a37f', '#4285f4', '#ff9f0a', '#30d158', '#bf5af2', '#98989d']

export interface NodeColorSwatchProps {
  color: string
  onColor: (c: string) => void
}

export default function NodeColorSwatch({ color, onColor }: NodeColorSwatchProps) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="node-swatch" title="Color" style={{ background: color }} onClick={() => setOpen((o) => !o)} />
      {open && (
        <span style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 10, marginTop: 4, display: 'flex',
          gap: 6, padding: 6, borderRadius: 8, background: 'var(--surface-raised, #1c1c1e)',
          border: '1px solid var(--border, #38383a)', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
        }}>
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className="node-swatch"
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
