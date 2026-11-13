// View controls of an editor node: word wrap (stored on the node) and "Fit width to content", plus
// the header's right-click menu that offers both after the node's own rows (Save, Go to Line…).
import { useMemo, useState, type MouseEvent } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { effectiveWrap, useWordWrap, useWrapChord, wrapChordLabel } from './editorWrap'
import { fitNodeWidth, fitRefusal } from './editorFit'
import { useNodeResizeState } from './nodeResize/nodeResize.store'
import { useTabLayout } from './tabLayout.store'
import type { MonacoApi } from './lazyMonaco'

type Live = { monaco: MonacoApi; editor: MonacoEditor.IStandaloneCodeEditor } | null

/** One header-menu row as a "…" More Actions row, so both menus offer the same editor actions. */
const toMenuItem = (r: MenuRow, i: number): VscodeMenuItem =>
  'type' in r ? { type: 'separator' } : { type: 'item', id: `editor-${i}`, label: r.label, disabled: r.disabled, title: r.hint, onSelect: r.onClick }

/** Word wrap + fit width for editor node `id`; `menu` renders the header right-click menu (`lead` rows first) while it is open, `items` are the same rows for "…". */
export function useEditorView(id: string, filePath: string, live: Live, minWidth: number, lead: MenuRow[] = []) {
  const rf = useReactFlow()
  const store = useStoreApi()
  const stored = useStore((s) => (s.nodeLookup.get(id)?.data as { wordWrap?: unknown } | undefined)?.wordWrap)
  const wrap = effectiveWrap(stored, filePath)
  const toggleWrap = () => rf.updateNodeData(id, (n) => ({ wordWrap: !effectiveWrap((n.data as { wordWrap?: unknown }).wordWrap, filePath) }))
  const target = useMemo(() => (live ? { monaco: live.monaco, options: live.editor, code: [live.editor] } : null), [live])
  useWordWrap(target, wrap, toggleWrap)
  const wrapKey = wrapChordLabel(useWrapChord())

  // Re-render on lock / tab mode so the refusal is current.
  useNodeResizeState()
  useTabLayout()
  const refusal = live ? fitRefusal(wrap) : 'The editor is still loading'
  const fit = () => {
    if (!live || fitRefusal(wrap)) return
    const charWidth = live.editor.getOption(live.monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth
    fitNodeWidth(store.getState(), id, live.editor, charWidth, minWidth)
  }

  const rows: MenuRow[] = [
    ...lead,
    ...(lead.length ? [{ type: 'separator' as const }] : []),
    { label: wrap ? 'Turn word wrap off' : 'Turn word wrap on', hint: wrapKey ? `Toggle word wrap (${wrapKey})` : 'Toggle word wrap', disabled: !live, onClick: toggleWrap },
    { label: 'Fit width to content', hint: refusal ?? 'Size the node to the longest visible line', disabled: !!refusal, onClick: fit },
  ]
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const openMenu = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); setAt({ x: e.clientX, y: e.clientY }) }
  const menu = at && <NodeContextMenu x={at.x} y={at.y} onClose={() => setAt(null)} rows={rows} />
  return { wrap, toggleWrap, fit, menu, openMenu, items: rows.map(toMenuItem) }
}
