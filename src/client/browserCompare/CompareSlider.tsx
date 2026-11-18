// A 0-100 slider (role=slider) measured against its parent: drag with the pointer, arrows (Shift = 10), Home/End.
// Used as the swipe divider over the stage and as the onion-skin opacity track.
import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'

export interface CompareSliderProps {
  value: number
  onChange: (v: number) => void
  label: string
  /** What the number means, for screen readers ("50% opacity"). */
  valueText?: string
  className?: string
  children?: ReactNode
}

/** Pointer position as 0-100 across `rect` (horizontal). */
export const percentAt = (clientX: number, rect: { left: number; width: number }): number =>
  rect.width > 0 ? Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)) : 0

export function CompareSlider({ value, onChange, label, valueText, className, children }: CompareSliderProps) {
  const drag = useRef(false)
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const track = e.currentTarget.parentElement
    if (track) onChange(percentAt(e.clientX, track.getBoundingClientRect()))
  }
  const onKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 10 : 1
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? value - step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? value + step : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null
    if (next === null) return
    e.preventDefault()
    onChange(Math.min(100, Math.max(0, next)))
  }
  return (
    <div
      role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={valueText} aria-orientation="horizontal"
      className={`bc-slider nodrag nopan nowheel ${className ?? ''}`} style={{ left: `${value}%` }}
      onKeyDown={onKey}
      onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); move(e) }}
      onPointerMove={(e) => { if (drag.current) move(e) }}
      onPointerUp={(e) => { drag.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId) }}
      onPointerCancel={() => { drag.current = false }}
    >
      {children}
    </div>
  )
}
