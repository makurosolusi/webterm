// Inline text input at the clicked point. Enter adds the text, Shift+Enter starts a new line,
// Escape cancels only this text, and leaving the field adds it (empty text is dropped by the model).
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { SHOT_FONT } from '../shot.palette'
import type { Point, TextShape } from '../shot.types'
import { SHOT_TEXT } from './shot.ui.text'

export interface ShotTextEditorProps {
  /** Anchor in image px (top-left of the text). */
  at: Point
  scale: number
  color: string
  size: number
  onCommit: (shape: TextShape) => void
  onCancel: () => void
}

export function ShotTextEditor({ at, scale, color, size, onCommit, onCancel }: ShotTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => ref.current?.focus(), [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const text = ref.current?.value ?? ''
    if (commit && text.trim() !== '') onCommit({ kind: 'text', color, at, text, size, background: false })
    else onCancel()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Escape and Enter end this text only (they must not also close the overlay); every other key bubbles to
    // the overlay root, which keeps the app's global shortcuts out and handles Mod+S and the toggle chord.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); finish(true) }
  }
  return (
    <Textarea
      ref={ref}
      className="shot-text"
      aria-label={SHOT_TEXT.textInput}
      rows={1}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      style={{ left: at.x / scale, top: at.y / scale, color, fontSize: size / scale, fontFamily: SHOT_FONT, lineHeight: 1.25 }}
    />
  )
}
