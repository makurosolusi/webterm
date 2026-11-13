// Status bar of an editor node, like VS Code's: `Ln 12, Col 5 (3 selected)` · `Spaces: 2` · `UTF-8` ·
// `LF` · `YAML`, read from the live Monaco editor; an image or media preview shows its size facts
// instead. Clicks run Monaco's own actions (Go to Line, indentation) or switch the line ending.
// Settings › Canvas › Status bar turns it off, as for terminal and agent nodes (NodeStatusBar).
import { useEffect, useState, type MouseEvent } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { IconTooltip } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import { useLiveSettings } from './useSettings'
import { formatBytes } from '../shared/fsLimits'
import type { ReadEncoding } from '../shared/fsContract'
import type { MonacoApi } from './lazyMonaco'
import type { ViewerMeta } from './viewers/ViewerHost'
import './node-statusbar.css'

export type EditorLive = { monaco: MonacoApi; editor: MonacoEditor.IStandaloneCodeEditor } | null
export type { ViewerMeta }

export const EDITOR_STATUS_TEXT = {
  bar: 'Editor status',
  saving: 'Saving…',
  gotoLine: 'Go to Line/Column',
  indentation: 'Select Indentation',
  eol: 'Select End of Line Sequence',
  language: 'Language mode',
} as const

/** Run Monaco action `id` in `editor`, focused first so its quick pick opens over this editor. */
export function runEditorAction(editor: Pick<MonacoEditor.IStandaloneCodeEditor, 'focus' | 'trigger'>, id: string): void {
  editor.focus()
  editor.trigger('webterm', id, null)
}

/** The text facts the bar shows; null until the editor has a model. */
export function editorFacts(live: NonNullable<EditorLive>) {
  const { editor, monaco } = live
  const model = editor.getModel()
  if (!model) return null
  const pos = editor.getPosition()
  const sels = editor.getSelections() ?? []
  const chars = sels.length === 1 ? model.getValueLengthInRange(sels[0]) : 0
  const selected = sels.length > 1 ? ` (${sels.length} selections)` : chars ? ` (${chars} selected)` : ''
  const opts = model.getOptions()
  const id = model.getLanguageId()
  const lang = monaco.languages.getLanguages().find((l) => l.id === id)
  return {
    position: `Ln ${pos?.lineNumber ?? 1}, Col ${pos?.column ?? 1}${selected}`,
    indent: opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab Size: ${opts.tabSize}`,
    eol: model.getEOL() === '\r\n' ? 'CRLF' as const : 'LF' as const,
    language: lang?.aliases?.[0] ?? id,
  }
}

/** `1920×1080 · 245.3 KB` parts for a viewer, from whatever it reported. */
export function viewerFacts(meta: ViewerMeta): string[] {
  return [
    ...(meta.width && meta.height ? [`${meta.width}×${meta.height}`] : []),
    ...(meta.bytes !== undefined ? [formatBytes(meta.bytes)] : []),
  ]
}

export interface EditorStatusBarProps {
  live: EditorLive
  encoding: ReadEncoding
  saving: boolean
  readOnly: boolean
  meta?: ViewerMeta | null
}

type Item = { id: string; text: string; tip: string; onClick?: (e: MouseEvent) => void }

function Bar({ live, encoding, saving, readOnly, meta }: EditorStatusBarProps): React.JSX.Element | null {
  const [, setTick] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; rows: MenuRow[] } | null>(null)
  useEffect(() => {
    if (!live) return
    const bump = () => setTick((t) => t + 1)
    // Typing moves the cursor, so the selection event also covers edits; the EOL switch bumps itself.
    const subs = [
      live.editor.onDidChangeCursorSelection(bump),
      live.editor.onDidChangeModelOptions(bump),
      live.editor.onDidChangeModelLanguage(bump),
    ]
    return () => subs.forEach((s) => s.dispose())
  }, [live])

  const open = (rows: MenuRow[]) => (e: MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, rows })
  const items: Item[] = []
  if (saving) items.push({ id: 'saving', text: EDITOR_STATUS_TEXT.saving, tip: 'Writing the file to disk' })
  const facts = live && editorFacts(live)
  if (live && facts) {
    const { editor, monaco } = live
    const act = (label: string, id: string, disabled = false): MenuRow => ({ label, disabled, onClick: () => runEditorAction(editor, id) })
    const setEol = (crlf: boolean) => {
      editor.getModel()?.pushEOL(crlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
      setTick((t) => t + 1)
    }
    const check = (on: boolean) => (on ? <span className="codicon codicon-check" aria-hidden="true" /> : undefined)
    items.push(
      { id: 'position', text: facts.position, tip: EDITOR_STATUS_TEXT.gotoLine, onClick: () => runEditorAction(editor, 'editor.action.gotoLine') },
      { id: 'indent', text: facts.indent, tip: EDITOR_STATUS_TEXT.indentation, onClick: open([
        act('Indent Using Spaces', 'editor.action.indentUsingSpaces'),
        act('Indent Using Tabs', 'editor.action.indentUsingTabs'),
        act('Change Tab Display Size', 'editor.action.changeTabDisplaySize'),
        { type: 'separator' },
        act('Convert Indentation to Spaces', 'editor.action.indentationToSpaces', readOnly),
        act('Convert Indentation to Tabs', 'editor.action.indentationToTabs', readOnly),
      ]) },
      { id: 'encoding', text: encoding === 'utf8' ? 'UTF-8' : 'Not UTF-8', tip: encoding === 'utf8' ? 'Encoding: UTF-8' : 'Not UTF-8: opened read-only so the original bytes are not corrupted' },
      { id: 'eol', text: facts.eol, tip: EDITOR_STATUS_TEXT.eol, onClick: readOnly ? undefined : open([
        { label: 'LF', icon: check(facts.eol === 'LF'), onClick: () => setEol(false) },
        { label: 'CRLF', icon: check(facts.eol === 'CRLF'), onClick: () => setEol(true) },
      ]) },
      // Monaco has no language picker of its own, so the mode is shown, not switched.
      { id: 'language', text: facts.language, tip: `${EDITOR_STATUS_TEXT.language}: ${facts.language}` },
    )
  } else if (meta) {
    for (const [i, text] of viewerFacts(meta).entries()) items.push({ id: `meta${i}`, text, tip: i === 0 && meta.width ? 'Image size in pixels' : 'File size' })
  }
  if (items.length === 0) return null

  return (
    <footer className="node-statusbar editor-statusbar nodrag" aria-label={EDITOR_STATUS_TEXT.bar}>
      <span className="node-statusbar__items editor-statusbar__items">
        {items.map((it) => (
          <IconTooltip key={it.id} label={it.tip} side="top">
            {it.onClick ? (
              // shadcn Button; the unlayered `.node-statusbar__item` reset gives it the status-bar look.
              <Button variant="ghost" size="xs" className="node-statusbar__item" data-item={it.id} onClick={it.onClick}>{it.text}</Button>
            ) : (
              <span tabIndex={0} className="node-statusbar__item editor-statusbar__static" data-item={it.id}>{it.text}</span>
            )}
          </IconTooltip>
        ))}
      </span>
      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menu.rows} onClose={() => setMenu(null)} />}
    </footer>
  )
}

/** Renders nothing while Settings › Canvas › Status bar is off (`nodeStatusBar`) or there is nothing to show. */
export default function EditorStatusBar(props: EditorStatusBarProps): React.JSX.Element | null {
  return useLiveSettings().nodeStatusBar ? <Bar {...props} /> : null
}
