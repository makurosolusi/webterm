// Color, stroke width and text size as preset swatches/buttons (nothing to type). Which size row shows depends on the tool.
import { IconButton } from '@/components/ui/icon-button'
import { SHOT_COLORS, SHOT_TEXT_SIZES, SHOT_WIDTHS } from '../shot.palette'
import type { Tool } from '../shot.types'
import { SHOT_TEXT } from './shot.ui.text'

export interface ShotColorPopoverProps {
  tool: Tool | null
  color: string
  width: number
  textSize: number
  side: 'left' | 'right'
  onColor: (c: string) => void
  onWidth: (w: number) => void
  onTextSize: (s: number) => void
}

export function ShotColorPopover({ tool, color, width, textSize, side, onColor, onWidth, onTextSize }: ShotColorPopoverProps) {
  const isText = tool === 'text'
  const sizes = isText ? SHOT_TEXT_SIZES : SHOT_WIDTHS
  const names = isText ? SHOT_TEXT.sizes : SHOT_WIDTHS.map((_, i) => SHOT_TEXT.widths[i])
  const current = isText ? textSize : width
  const pick = isText ? onTextSize : onWidth
  return (
    <div className={`shot-popover shot-popover--${side}`} role="group" aria-label={SHOT_TEXT.colorPicker}>
      <div className="shot-popover__row" role="group" aria-label={SHOT_TEXT.color}>
        {SHOT_COLORS.map((c) => (
          <IconButton key={c.value} label={c.name} side="bottom" className="shot-btn shot-btn--swatch" aria-pressed={c.value === color} onClick={() => onColor(c.value)}>
            <span className="shot-swatch" style={{ background: c.value }} />
          </IconButton>
        ))}
      </div>
      <div className="shot-popover__row" role="group" aria-label={isText ? SHOT_TEXT.textSize : SHOT_TEXT.stroke}>
        {sizes.map((v, i) => (
          <IconButton key={v} label={`${isText ? SHOT_TEXT.textSize : SHOT_TEXT.stroke}: ${names[i]}`} side="bottom" className="shot-btn" aria-pressed={v === current} onClick={() => pick(v)}>
            {isText
              ? <span className="shot-size" style={{ fontSize: 10 + i * 4 }}>A</span>
              : <span className="shot-stroke" style={{ height: 2 + i * 2 }} />}
          </IconButton>
        ))}
      </div>
    </div>
  )
}
