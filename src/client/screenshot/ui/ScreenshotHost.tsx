// Always-mounted host of the screenshot annotator: owns the state machine, runs the capture before the
// overlay exists, performs copy/save, and turns every outcome into a notice (the app's toast stack).
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePortalContainer } from '@/components/vscode/portalContainer'
import { closeNotice, showNotice } from '@/workspaceSave.notice'
import { captureFrame } from '../shot.capture'
import { SHOT_IGNORE_ATTR } from '../../canvasShot'
import { copyImage, exportPng, saveImage, shotFileName } from '../shot.export'
import { initialState, shotReducer, type ExportKind } from './shot.ui.machine'
import { loadPrefs } from './shot.ui.prefs'
import { SCREENSHOT_NOTICE_KEY, SHOT_TEXT } from './shot.ui.text'
import { onScreenshotStart, startScreenshot } from './screenshot.start'
import { ShotOverlay } from './ShotOverlay'
import './shot.ui.css'

export function ScreenshotHost() {
  const [state, dispatch] = useReducer(shotReducer, undefined, () => initialState(loadPrefs()))
  const latest = useRef(state)
  latest.current = state
  const mounted = useRef(true)
  const container = usePortalContainer()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const begin = useCallback((): void => {
    const s = latest.current
    if (s.phase === 'selecting' || s.phase === 'selected') { dispatch({ type: 'close' }); return }
    if (s.phase !== 'idle') return
    dispatch({ type: 'start' })
    void captureFrame().then((r) => {
      if (!mounted.current) return
      if (r.ok) dispatch({ type: 'captured', frame: r.frame, css: { w: r.cssWidth, h: r.cssHeight }, scale: r.scale })
      else dispatch({ type: 'captureFailed', reason: r.reason })
    })
  }, [])
  useEffect(() => onScreenshotStart(begin), [begin])

  const onExport = useCallback((kind: ExportKind): void => {
    const s = latest.current
    if (s.phase !== 'selected' || !s.selection || !s.frame) return
    dispatch({ type: 'exportStart', kind })
    const name = shotFileName()
    exportPng(s.frame, s.selection, s.shots.shapes)
      .then(async (blob) => {
        if (kind === 'copy') return copyImage(blob)
        saveImage(blob, name)
        return 'ok' as const
      })
      .catch((err: unknown) => {
        console.warn('[webterm] screenshot export failed', err)
        return 'failed' as const
      })
      .then((result) => { if (mounted.current) dispatch({ type: 'exportDone', kind, result, name }) })
  }, [])

  // Show each new notice once, with the way out the machine chose for it.
  const notice = state.notice
  useEffect(() => {
    if (!notice) return
    showNotice(SCREENSHOT_NOTICE_KEY, {
      severity: notice.kind, title: notice.title, message: notice.message,
      actions: notice.action === 'save' ? [{ label: SHOT_TEXT.saveAction, onClick: () => { closeNotice(SCREENSHOT_NOTICE_KEY); onExport('save') } }]
        : notice.action === 'retry' ? [{ label: SHOT_TEXT.retryAction, onClick: () => { closeNotice(SCREENSHOT_NOTICE_KEY); startScreenshot() } }] : [],
    })
  }, [notice, onExport])
  useEffect(() => () => closeNotice(SCREENSHOT_NOTICE_KEY), [])

  if (state.phase === 'idle') return null
  return createPortal(
    state.phase === 'capturing'
      // Blocks input while the page is cloned; the ignore attribute keeps it out of the picture.
      ? <div {...{ [SHOT_IGNORE_ATTR]: '' }} className="shot-busy" role="status" aria-live="polite"><span className="shot-busy__pill">{SHOT_TEXT.capturing}</span></div>
      : <ShotOverlay state={state} dispatch={dispatch} onExport={onExport} />,
    container,
  )
}
