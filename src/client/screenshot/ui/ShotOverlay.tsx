// The annotator overlay: a modal dialog over the frozen page. Owns focus (trap + restore), the keyboard map
// and the layout of its parts; the state machine and the export live in the host.
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent } from 'react'
import { SHOT_IGNORE_ATTR } from '../../canvasShot'
import { canRedo, canUndo } from '../shot.model'
import { isMacPlatform } from '@/terminalKeys'
import type { Point, Shape, Tool } from '../shot.types'
import type { ExportKind, UiAction, UiState } from './shot.ui.machine'
import { placeBar, placeRail, toCss } from './shot.ui.layout'
import { keyIntent } from './shot.ui.keys'
import { savePrefs } from './shot.ui.prefs'
import { SHOT_TEXT } from './shot.ui.text'
import { ShotActionBar } from './ShotActionBar'
import { ShotPreview } from './ShotPreview'
import { ShotSelection } from './ShotSelection'
import { ShotTextEditor } from './ShotTextEditor'
import { ShotToolRail } from './ShotToolRail'
import { useShotPointer } from './useShotPointer'
import './shot.ui.css'

const FOCUSABLE = 'button:not([disabled]), textarea, [tabindex="0"]'

export interface ShotOverlayProps {
  state: UiState
  dispatch: Dispatch<UiAction>
  onExport: (kind: ExportKind) => void
}

export function ShotOverlay({ state, dispatch, onExport }: ShotOverlayProps) {
  const root = useRef<HTMLDivElement>(null)
  const [textAt, setTextAt] = useState<Point | null>(null)
  const { frame, css, scale, selection, phase, tool, color, width, textSize, shots, notice } = state
  const { draft, surfaceProps } = useShotPointer({ state, dispatch, onText: setTextAt })

  // Focus moves in on open and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.focus()
    return () => { if (before?.isConnected) before.focus() }
  }, [])
  useEffect(() => savePrefs({ color, width, textSize }), [color, width, textSize])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Modal: no key of the overlay reaches the app's global shortcuts.
    e.stopPropagation()
    if (e.key === 'Tab') {
      const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey ? active === first || active === root.current : active === last) { e.preventDefault(); (e.shiftKey ? last : first)?.focus() }
      else if (!root.current?.contains(active)) { e.preventDefault(); first?.focus() }
      return
    }
    const intent = keyIntent(e.nativeEvent, e.target, isMacPlatform())
    if (!intent) return
    e.preventDefault()
    if (intent === 'close') dispatch({ type: 'close' })
    else if (intent === 'selectAll') dispatch({ type: 'selectAll' })
    else if (intent === 'undo' || intent === 'redo') dispatch({ type: intent })
    else onExport(intent)
  }

  const commitText = (shape: Shape): void => { dispatch({ type: 'addShape', shape }); setTextAt(null) }
  const setTool = (t: Tool | null): void => { setTextAt(null); dispatch({ type: 'setTool', tool: t }) }

  const interactive = phase === 'selected'
  const busy = phase === 'copying' || phase === 'saving' ? phase : null
  const selCss = selection ? toCss(selection, scale) : null
  const rail = selCss && (interactive || busy) ? placeRail(selCss, css) : null
  const bar = selCss && (interactive || busy) ? placeBar(selCss, css) : null

  return (
    <div
      ref={root}
      {...{ [SHOT_IGNORE_ATTR]: '' }}
      className="shot-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={SHOT_TEXT.dialog}
      aria-busy={busy !== null}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {frame && <ShotPreview frame={frame} css={css} scale={scale} selection={selection} shapes={shots.shapes} draft={draft} />}
      <div className="shot-surface" data-testid="shot-surface" {...surfaceProps} />
      {phase === 'selecting' && !selection && <p className="shot-hint">{SHOT_TEXT.selectionHint}</p>}
      {selection && frame && (
        <ShotSelection selection={selection} scale={scale} bounds={{ w: frame.width, h: frame.height }} interactive={interactive}
          onChange={(rect) => dispatch({ type: 'setSelection', rect })} />
      )}
      {rail && (
        <ShotToolRail x={rail.x} y={rail.y} side={rail.side} viewportWidth={css.w} tool={tool} color={color} width={width} textSize={textSize}
          canUndo={canUndo(shots)} canRedo={canRedo(shots)} onTool={setTool} onUndo={() => dispatch({ type: 'undo' })} onRedo={() => dispatch({ type: 'redo' })}
          onColor={(c) => dispatch({ type: 'setColor', color: c })} onWidth={(w) => dispatch({ type: 'setWidth', width: w })}
          onTextSize={(s) => dispatch({ type: 'setTextSize', size: s })} />
      )}
      {bar && <ShotActionBar x={bar.x} y={bar.y} busy={busy} onCopy={() => onExport('copy')} onSave={() => onExport('save')} onClose={() => dispatch({ type: 'close' })} />}
      {textAt && <ShotTextEditor at={textAt} scale={scale} color={color} size={textSize} onCommit={commitText} onCancel={() => setTextAt(null)} />}
      <div className="shot-sr" role="status" aria-live="polite">{busy ? SHOT_TEXT.busy[busy] : notice?.title}</div>
    </div>
  )
}
