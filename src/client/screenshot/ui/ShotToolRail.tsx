// Vertical tool rail beside the selection: drawing tools, the color/size picker, undo and redo.
import { useState } from 'react'
import { ArrowUpRight, Highlighter, Pencil, Redo2, Slash, Square, Type, Undo2, type LucideIcon } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { chordLabel } from '@/commandRegistry'
import { isMacPlatform } from '@/terminalKeys'
import type { Tool } from '../shot.types'
import { popoverSide, type RailSide } from './shot.ui.layout'
import { ShotColorPopover, type ShotColorPopoverProps } from './ShotColorPopover'
import { SHOT_TEXT, TOOL_LABEL } from './shot.ui.text'

const TOOLS: ReadonlyArray<[Tool, LucideIcon]> = [
  ['pen', Pencil], ['line', Slash], ['arrow', ArrowUpRight], ['rect', Square], ['marker', Highlighter], ['text', Type],
]

export interface ShotToolRailProps extends Omit<ShotColorPopoverProps, 'side'> {
  x: number
  y: number
  side: RailSide
  viewportWidth: number
  canUndo: boolean
  canRedo: boolean
  onTool: (t: Tool | null) => void
  onUndo: () => void
  onRedo: () => void
}

export function ShotToolRail(p: ShotToolRailProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const key = (chord: string): string => chordLabel(chord, isMacPlatform())
  return (
    <div className="shot-bar shot-bar--rail" role="toolbar" aria-orientation="vertical" aria-label={SHOT_TEXT.rail} style={{ left: p.x, top: p.y }}>
      {TOOLS.map(([tool, Icon]) => (
        <IconButton key={tool} label={TOOL_LABEL[tool]} side="left" className="shot-btn" aria-pressed={p.tool === tool}
          onClick={() => p.onTool(p.tool === tool ? null : tool)}>
          <Icon aria-hidden />
        </IconButton>
      ))}
      <IconButton label={SHOT_TEXT.color} side="left" className="shot-btn" aria-pressed={pickerOpen} aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
        <span className="shot-swatch shot-swatch--current" style={{ background: p.color }} />
      </IconButton>
      <IconButton label={SHOT_TEXT.undo} shortcut={key('Mod+Z')} side="left" className="shot-btn" disabled={!p.canUndo} disabledReason={SHOT_TEXT.nothingToUndo} onClick={p.onUndo}>
        <Undo2 aria-hidden />
      </IconButton>
      <IconButton label={SHOT_TEXT.redo} shortcut={key('Mod+Shift+Z')} side="left" className="shot-btn" disabled={!p.canRedo} disabledReason={SHOT_TEXT.nothingToRedo} onClick={p.onRedo}>
        <Redo2 aria-hidden />
      </IconButton>
      {pickerOpen && <ShotColorPopover {...p} side={popoverSide(p.x, p.viewportWidth)} />}
    </div>
  )
}
