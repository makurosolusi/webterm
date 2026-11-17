// Workspace color picker: 12 named swatches + 3 shades + Random, all radio buttons / buttons (no hex
// typing). Every choice is saved at once through `onChange` (optimistic in the lifecycle, rolled back
// and reported there on failure); the dialog only reflects the workspace's current color.
import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DEFAULT_WORKSPACE_SHADE, WORKSPACE_HUES, WORKSPACE_SHADES, isWorkspaceHue, isWorkspaceShade, workspaceColorVar, workspaceHueLabel,
} from '../shared/workspaceColor'
import type { ColorChange } from './api'

interface RadioItem { id: string; label: string; swatch: string }

/** ARIA radio group: arrows move AND select (wrapping), only the checked item is in the tab order. */
function RadioRow({ label, items, value, onPick }: { label: string; items: RadioItem[]; value: string; onPick: (id: string) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, index: number): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (index + step + items.length) % items.length
    refs.current[next]?.focus()
    onPick(items[next].id)
  }
  return (
    <div role="radiogroup" aria-label={label} className="ws-color-row">
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={item.id === value}
          aria-label={item.label}
          title={item.label}
          tabIndex={item.id === value ? 0 : -1}
          className="ws-swatch"
          style={{ '--ws-swatch': item.swatch } as React.CSSProperties}
          onClick={() => onPick(item.id)}
          onKeyDown={(e) => onKey(e, i)}
        />
      ))}
    </div>
  )
}

export interface WorkspaceColorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceName: string
  color: string | undefined
  colorShade: string | undefined
  onChange: (change: ColorChange) => void
}

/** "Workspace color" dialog for one workspace (opened from its tab's context menu). */
export function WorkspaceColorDialog({ open, onOpenChange, workspaceName, color, colorShade, onChange }: WorkspaceColorDialogProps) {
  const hue = isWorkspaceHue(color) ? color : 'slate'
  const shade = isWorkspaceShade(colorShade) ? colorShade : DEFAULT_WORKSPACE_SHADE
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ws-color-dialog">
        <DialogHeader><DialogTitle>Color of {workspaceName}</DialogTitle></DialogHeader>
        <p className="ws-color-hint">The tab, the status bar and the sidebar use this color, so you can tell workspaces apart at a glance.</p>
        <RadioRow
          label="Workspace color"
          value={hue}
          items={WORKSPACE_HUES.map((h) => ({ id: h, label: workspaceHueLabel(h), swatch: workspaceColorVar(h, shade) }))}
          onPick={(id) => onChange({ color: id })}
        />
        <RadioRow
          label="Shade"
          value={shade}
          items={WORKSPACE_SHADES.map((s) => ({ id: s, label: s[0].toUpperCase() + s.slice(1), swatch: workspaceColorVar(hue, s) }))}
          onPick={(id) => onChange({ colorShade: id })}
        />
        <div className="ws-color-actions">
          <Button variant="secondary" onClick={() => onChange({ random: true })}>Random</Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
