// Secret masking for the editor node. While masked, the Monaco model holds read-only DISPLAY text
// (same length, bullets over secrets); the real text lives only in `realRef`. "Edit" swaps the real
// text in (editable); it swaps back only once nothing is unsaved. Design: docs/decisions/secret-masking.md.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { detectSecrets, type SecretScan } from '../shared/secretMask.detect'
import { hasReveal, hiddenState, maskText } from './secretMask.reveal'
import { useSecretReveal } from './secretMask.useReveal'
import { useLiveSettings } from './useSettings'
import { publishMaskSetting } from './editorMask.live'
import { useMaskTokens } from './editorMask.tokens'

/** off: nothing hidden; masked: display text, read-only; edit: real text, editable. */
export type MaskMode = 'off' | 'masked' | 'edit'
/** hidden: secrets were hidden again; pending: a hide is waiting for save/discard. */
export type MaskNotice = 'hidden' | 'pending'
export type EditorMask = ReturnType<typeof useEditorMask>

const EMPTY: SecretScan = { fileWide: false, ranges: [], truncated: false }
const hasSecrets = (s: SecretScan): boolean => s.fileWide || s.ranges.length > 0

/**
 * Replace the model text. `model.setValue` (Monaco 0.57 textModel.js) clears the undo stack and the
 * model decorations, so no undo path reaches the other text; cursor/scroll are restored around it.
 */
export function swapText(ed: MonacoEditor.IStandaloneCodeEditor, text: string, readOnly: boolean): void {
  const model = ed.getModel()
  if (model && model.getValue() !== text) {
    const view = ed.saveViewState()
    model.setValue(text)
    if (view) ed.restoreViewState(view)
  }
  ed.updateOptions({ readOnly })
}

export interface UseEditorMaskArgs {
  pathRef: RefObject<string>
  editor: MonacoEditor.IStandaloneCodeEditor | null
  dirty: boolean
  /** Non-UTF-8 file: stays read-only even in edit mode. */
  fileReadOnly: RefObject<boolean>
}

export function useEditorMask({ pathRef, editor, dirty, fileReadOnly }: UseEditorMaskArgs) {
  const settings = useLiveSettings()
  const on = settings.maskSecrets
  const onRef = useRef(on)
  onRef.current = on
  const [mode, setModeState] = useState<MaskMode>('off')
  const modeRef = useRef<MaskMode>('off')
  const [scan, setScan] = useState<SecretScan>(EMPTY)
  const [notice, setNotice] = useState<MaskNotice | null>(null)
  const realRef = useRef('')
  const manualHide = useRef(false)
  const setMode = useCallback((m: MaskMode) => { modeRef.current = m; setModeState(m) }, [])
  const reveal = useSecretReveal({ scan, autoHideSec: settings.maskAutoHideSec, enabled: mode !== 'off' })
  const revealed = hasReveal(reveal.state)

  /** Called with the text read from disk; returns what the model must hold. */
  const load = useCallback((content: string): string => {
    realRef.current = content
    if (modeRef.current === 'edit') return content // reload while editing keeps the secrets visible
    const s = onRef.current ? detectSecrets(pathRef.current, content) : EMPTY
    const masked = hasSecrets(s)
    setScan(s)
    setMode(masked ? 'masked' : 'off')
    if (!masked) realRef.current = ''
    return masked ? maskText(content, s, hiddenState()) : content
  }, [pathRef, setMode])

  const reset = useCallback(() => { realRef.current = ''; setScan(EMPTY); setMode('off'); setNotice(null) }, [setMode])

  /** Scan `text` (the buffer) and enter masked mode, or edit mode when it holds unsaved edits. */
  const settle = (text: string, asEdit: boolean) => {
    const s = detectSecrets(pathRef.current, text)
    realRef.current = hasSecrets(s) ? text : ''
    setScan(s)
    setMode(hasSecrets(s) ? (asEdit ? 'edit' : 'masked') : 'off')
  }

  const edit = () => {
    if (!editor || mode !== 'masked' || fileReadOnly.current) return
    swapText(editor, realRef.current, false)
    setMode('edit')
    setNotice(null)
    reveal.revealAll()
  }
  const hide = () => {
    if (revealed) manualHide.current = true
    reveal.hideAll()
  }
  /** Review text read from disk for display (conflict compare): hidden while the buffer is masked. */
  const maskDisk = (path: string, content: string): string =>
    modeRef.current === 'masked' ? maskText(content, detectSecrets(path, content), hiddenState()) : content

  // Masked: the model follows the reveal state. Layout effect so a re-mask never paints real text.
  useLayoutEffect(() => {
    if (mode === 'masked' && editor) swapText(editor, maskText(realRef.current, scan, reveal.state), true)
  }, [mode, scan, reveal.state, editor])
  useMaskTokens(editor, mode, scan, reveal.state, reveal.revealIndex)

  // Revealed -> hidden that the user did not ask for (timer, blur, Escape, reload) gets a small notice.
  const wasRevealed = useRef(false)
  useEffect(() => {
    if (wasRevealed.current && !revealed) { if (manualHide.current) manualHide.current = false; else setNotice('hidden') }
    if (revealed) setNotice(null)
    wasRevealed.current = revealed
  }, [revealed])

  // DATA-LOSS GUARD: editing + nothing revealed (auto-hide fired) re-masks only when there is nothing unsaved.
  useEffect(() => {
    if (mode !== 'edit' || revealed) return
    if (dirty) { setNotice('pending'); return }
    if (editor) { settle(editor.getValue(), false); setNotice('hidden') }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settle only reads refs and setters
  }, [mode, revealed, dirty, editor])

  // The setting toggled live: release the buffer, or take it over (unsaved edits stay visible until saved).
  const prevOn = useRef(on)
  useEffect(() => {
    publishMaskSetting(on)
    if (prevOn.current === on) return
    prevOn.current = on
    if (!editor) return
    if (!on) {
      if (modeRef.current === 'masked') swapText(editor, realRef.current, !!fileReadOnly.current)
      reset()
    } else settle(editor.getValue(), dirty)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the setting only
  }, [on])

  return {
    mode, modeRef, notice, scan, revealed, load, reset, edit, hide, maskDisk,
    enabled: on, masked: reveal.masked, canEdit: !fileReadOnly.current,
    revealAll: reveal.revealAll, revealIndex: reveal.revealIndex,
  }
}
