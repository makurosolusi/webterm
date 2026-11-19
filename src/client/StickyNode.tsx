import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Textarea } from '@/components/ui/textarea'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { useNodeResizeState } from './nodeResize/nodeResize.store'
import { findNodeRoot, nodeIdOf } from './nodeRoot'
import { STICKY_DEFAULT_SIZE, STICKY_INK, STICKY_MIN_SIZE, STICKY_TEXT_MAX, cleanStickyText, normalizeStickyColor, stickyHex } from '../shared/sticky.palette'
import type { WsNode } from '../shared/workspace'
import { STICKY_COLOR_NAME, STICKY_TEXT } from './sticky.labels'
import { stickyCounterVisible, stickyFontSize, stickyOverflows, stickyTilt } from './sticky.model'
import { clearStickyEdit, peekStickyEdit } from './sticky.state'
import { StickyToolbar } from './stickyToolbar'
import './sticky.css'

const isTypingTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

/**
 * A FigJam-style sticky note: a small colored paper square with handwriting, no node chrome
 * (docs/decisions/sticky-note.md). Double-click or Enter edits in place; Esc or blur saves. Text lives in
 * `data.stickyText`; typing is local until it is committed, so a keystroke never triggers a workspace save.
 */
function StickyNode({ id, data, selected, width, height }: NodeProps) {
  const d = data as Pick<WsNode, 'stickyText' | 'stickyTag' | 'stickyColor'>
  const rf = useReactFlow()
  const { locked } = useNodeResizeState()
  const text = d.stickyText ?? ''
  const color = normalizeStickyColor(d.stickyColor)
  const w = width ?? STICKY_DEFAULT_SIZE.width
  const h = height ?? STICKY_DEFAULT_SIZE.height

  const [editing, setEditing] = useState(() => peekStickyEdit(id) && !locked)
  const [draft, setDraft] = useState(text)
  const editingRef = useRef(editing)
  const input = useRef<HTMLTextAreaElement>(null)
  editingRef.current = editing

  const begin = useCallback(() => {
    if (locked || editingRef.current) return
    setDraft(text)
    setEditing(true)
  }, [locked, text])

  const commit = useCallback((refocus: boolean) => {
    if (!editingRef.current) return // Esc unmounts the field, which can fire a blur right after
    editingRef.current = false
    setEditing(false)
    const next = cleanStickyText(draft)
    if (next !== text) rf.updateNodeData(id, { stickyText: next })
    if (refocus) requestAnimationFrame(() => findNodeRoot(id)?.focus({ preventScroll: true }))
  }, [draft, text, rf, id])

  // A freshly created note opens for typing; the request is consumed once the note is mounted.
  useEffect(() => { clearStickyEdit(id) }, [id])
  useEffect(() => {
    const el = input.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])
  // Locking the view mid-edit keeps what was typed, then goes read-only.
  useEffect(() => { if (locked) commit(false) }, [locked, commit])

  // Enter on the focused, selected note starts editing (capture phase: React Flow would treat Enter as a select toggle).
  useEffect(() => {
    if (!selected || editing || locked) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (isTypingTarget(e.target) || !(e.target instanceof Element) || nodeIdOf(e.target) !== id) return
      e.preventDefault()
      e.stopPropagation()
      begin()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [selected, editing, locked, id, begin])

  const onFieldKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Canvas shortcuts (Delete, arrows, plain hotkeys) already ignore a focused textarea (React Flow, the command
    // dispatcher); chords with a modifier stay live. Only Esc/Mod+Enter are ours, and they must not reach the canvas.
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.stopPropagation(); commit(true) }
  }

  const shown = editing ? draft : text
  const font = useMemo(() => stickyFontSize(shown, w, h), [shown, w, h])
  const scrolls = stickyOverflows(shown, w, h)
  const style = {
    '--sticky-bg': stickyHex(color), '--sticky-ink': STICKY_INK, '--sticky-tilt': `${stickyTilt(id)}deg`,
  } as CSSProperties

  return (
    <>
      <NodeLayoutResizer minWidth={STICKY_MIN_SIZE.width} minHeight={STICKY_MIN_SIZE.height} />
      {selected && !locked && <StickyToolbar id={id} tag={d.stickyTag ?? ''} color={color} />}
      <div
        role="group" aria-label={STICKY_TEXT.group(text.trim().slice(0, 80), STICKY_COLOR_NAME[color])}
        className="sticky-note" style={style} data-editing={editing || undefined} onDoubleClick={begin}
      >
        {d.stickyTag ? <span className="sticky-note__tag">{d.stickyTag}</span> : null}
        <div className={`sticky-note__body${scrolls ? ' sticky-note__body--scroll nowheel' : ''}`}>
          <div className="sticky-note__field" style={{ fontSize: font }}>
            {editing ? (
              <>
                <div className="sticky-note__text sticky-note__mirror" aria-hidden="true">{`${draft}\n`}</div>
                <Textarea
                  ref={input} className="sticky-note__input nodrag nowheel nopan" aria-label={STICKY_TEXT.textareaLabel}
                  placeholder={STICKY_TEXT.placeholder} maxLength={STICKY_TEXT_MAX} value={draft}
                  onChange={(e) => setDraft(e.target.value)} onKeyDown={onFieldKey} onBlur={() => commit(false)}
                />
              </>
            ) : (
              <div className={`sticky-note__text${text ? '' : ' sticky-note__text--empty'}`}>{text || STICKY_TEXT.placeholder}</div>
            )}
          </div>
        </div>
        {editing && stickyCounterVisible(draft.length) && <span className="sticky-note__count" role="status">{STICKY_TEXT.limit(draft.length, STICKY_TEXT_MAX)}</span>}
      </div>
    </>
  )
}

export default memo(StickyNode)
