import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { AgentStatus, Comment } from '../shared/workspace'
import { Textfield, ToolbarButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import NodeColorPicker, { NODE_COLOR_MENU_LABEL } from './NodeColorSwatch'
import { useNodeId } from '@xyflow/react'
import NodeToolbar, { nodeMoreItems, type NodeToolbarProps } from './NodeToolbar'
import TabNodeActions from './tabLayout.nodeActions'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import NodeComments from './NodeComments'
import { useNodeHost } from './tabLayout.context'
import { useNodeMaximize } from './nodeMaximize.store'
import { NodeNameLabel } from './nodeName.label'

export interface NodeChromeProps {
  /** Editable label (title or kind fallback); Rename edits this, never `name`. */
  title: string
  /** Unique node name ("Mango"), shown first; absent until the board has named the node. */
  name?: string
  /** Nama codicon untuk ikon tipe node di depan judul (mis. 'terminal', 'hubot'); kosong = tanpa ikon. */
  icon?: string
  /** Full class list of a typed icon (a file's codicon + colour tone); wins over `icon`. */
  iconClass?: string
  /** Teks redup setelah judul, seperti deskripsi tab editor (mis. cwd). */
  description?: string
  /** Title tooltip (e.g. a Files node's full path); a click on the title still renames. */
  titleHint?: string
  onRename: (t: string) => void
  collapsed: boolean; onToggleCollapse: () => void
  /** Node colour: a thin accent on the header's left edge, changed from "…" › Node color…. */
  color: string; onColor: (c: string) => void
  /** Status mark right after the title: an agent's labelled status chip, an editor's dirty dot. */
  statusChip?: ReactNode
  pill?: ReactNode                // <UsagePill/> for agent; omit for terminal
  comments: Comment[]; onAddComment: (text: string) => void
  // toolbar passthrough (NodeChrome owns comments open-state internally):
  /** Omit both when the node type has no such action (browser: reload and find live in its own toolbar). */
  onRefresh?: () => void
  searchOpen?: boolean; onToggleSearch?: () => void
  micActive?: boolean; onToggleMic?: () => void   // node tanpa input suara: tombol Dictate disembunyikan
  onClose: () => void
  /** Close tooltip; default names the session it ends. Nodes with no session say plain "Close". */
  closeLabel?: string
  /** Right-click on the header (VS Code tab context menu); omit for none. */
  onContextMenu?: (e: MouseEvent) => void
  onStop?: () => void             // agent only: Stop button in the toolbar
  onAiName?: () => void; aiNaming?: boolean
  onBroadcast?: () => void; broadcastActive?: boolean; broadcastDisabled?: boolean
  hideLinks?: boolean; onToggleHideLinks?: () => void
  extraHeader?: ReactNode         // Resume/Restart buttons for agent node (rendered just before toolbar)
  menuItems?: VscodeMenuItem[]    // item tambahan menu More Actions (⋯) khusus tipe node
}

/** Judul yang dipakai saat node belum punya nama — nodeterm merender `data.title || 'Untitled'`. */
export const UNTITLED = 'Untitled'

/**
 * className untuk elemen `.term-node`.
 *
 * `working`/`attention` sengaja TANPA prefiks: glow node digantung pada
 * `.react-flow__node:has(.term-node.working)::after` (dan padanannya `[data-tab-node]` di tab; pseudo-nya harus hidup di luar `.term-node`
 * yang `overflow: hidden`), dan selector itu disalin apa adanya dari nodeterm.
 *
 * Turn ended (`waiting`) gets no class: the shared status model treats it as calm idle, so the node
 * shows no ring. `attention` (red, pulsing) belongs to `blocked` only.
 */
export function termNodeClass(o: { selected?: boolean; collapsed?: boolean; status?: AgentStatus }): string {
  return (
    'term-node' +
    (o.selected ? ' term-node--selected' : '') +
    (o.collapsed ? ' term-node--collapsed' : '') +
    (o.status === 'working' ? ' working' : '') +
    (o.status === 'blocked' ? ' attention' : '')
  )
}

/** Header elements that own their clicks, so a double-click on them is not Maximize. */
const HEADER_CONTROLS = '.nodrag, button, a, input, [role="button"], [role="menu"]'

export default function NodeChrome(props: NodeChromeProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const titleRef = useRef<HTMLElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  // Tab mode is view-only: collapse/resize/maximize would rewrite the node's canvas layout. A
  // maximized node keeps its canvas layout too, so collapse/resize hide there as well.
  const { inTab, visible } = useNodeHost()
  const nodeId = useNodeId()
  const max = useNodeMaximize()
  const fixedLayout = inTab || max.maximized
  // Double-click on the bare header toggles Maximize (VS Code: double-click the editor tab bar).
  // Controls are excluded; so is the title (`nodrag`), whose single click is Rename.
  const onHeaderDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (max.toggle && !(e.target as Element).closest(HEADER_CONTROLS)) max.toggle()
  }

  const beginEdit = () => { setDraft(props.title); setEditing(true) }
  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next) props.onRename(next)
  }
  // `delegatesFocus` di vscode-textfield membuat fokus host diteruskan ke input di shadow DOM.
  useEffect(() => {
    if (editing) titleRef.current?.focus()
  }, [editing])
  const onTitleKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
  }

  // The colour lives in the menu (VS Code tab colour), never as a coloured button that reads as status.
  const colorItem: VscodeMenuItem = { type: 'item', id: 'color', label: NODE_COLOR_MENU_LABEL, onSelect: () => setColorOpen(true) }
  const renameItem: VscodeMenuItem = { type: 'item', id: 'rename', label: 'Rename…', onSelect: beginEdit }
  const toolbar: NodeToolbarProps = {
    onRefresh: props.onRefresh,
    searchOpen: props.searchOpen, onToggleSearch: props.onToggleSearch,
    micActive: props.micActive, onToggleMic: props.onToggleMic,
    commentsOpen, onToggleComments: () => setCommentsOpen((o) => !o), commentCount: props.comments.length,
    maximized: max.maximized, onToggleMaximize: () => max.toggle?.(), hideMaximize: !max.toggle,
    onClose: props.onClose, closeLabel: props.closeLabel,
    onStop: props.onStop,
    onAiName: props.onAiName, aiNaming: props.aiNaming,
    onBroadcast: props.onBroadcast, broadcastActive: props.broadcastActive, broadcastDisabled: props.broadcastDisabled,
    hideLinks: props.hideLinks, onToggleHideLinks: props.onToggleHideLinks,
    // Tab mode is view-only (no header to anchor the picker or the title field on), so no colour or rename row there.
    extraMenuItems: inTab ? props.menuItems : [...(props.menuItems ?? []), renameItem, colorItem],
  }
  const comments = commentsOpen && (
    <NodeComments comments={props.comments} onAdd={props.onAddComment} onClose={() => setCommentsOpen(false)} />
  )

  // Tab mode: the tab is the header (title, status dot, close). Its other actions move to the tab
  // strip (editor actions + tab context menu); only the tab's × closes the node.
  if (inTab) {
    return (
      <>
        <TabNodeActions
          id={nodeId} visible={visible} items={nodeMoreItems(toolbar)} onStop={props.onStop}
          search={props.onToggleSearch ? { open: Boolean(props.searchOpen), toggle: props.onToggleSearch } : undefined}
          extra={props.pill || props.extraHeader ? <>{props.pill}{props.extraHeader}</> : undefined}
        />
        {comments && <div className="node-tab-comments relative">{comments}</div>}
      </>
    )
  }

  return (
    <div ref={headerRef} className="node-header relative" onDoubleClick={onHeaderDoubleClick} onContextMenu={props.onContextMenu} style={{ '--nc-node-color': props.color } as CSSProperties}>
      {!fixedLayout && (
        <IconTooltip label={props.collapsed ? 'Expand' : 'Collapse'}>
          <ToolbarButton
            label={props.collapsed ? 'Expand' : 'Collapse'}
            className="nodrag"
            data-title={props.collapsed ? 'Expand' : 'Collapse'}
            onClick={props.onToggleCollapse}
          ><span className={cn('codicon', props.collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down')} aria-hidden="true" /></ToolbarButton>
        </IconTooltip>
      )}

      {(props.iconClass || props.icon) && <span className={cn('node-icon', props.iconClass ?? `codicon codicon-${props.icon}`)} aria-hidden="true" />}

      {editing ? (
        <Textfield
          ref={(node) => { titleRef.current = node }}
          className="nodrag node-title--edit" value={draft}
          // `input` adalah event yang diteruskan wrapper; `target` sudah di-retarget ke host,
          // yang menyimpan properti `value` milik vscode-textfield.
          onInput={(e) => setDraft((e.target as unknown as { value: string }).value)}
          onKeyDown={onTitleKey} onBlur={commit}
        />
      ) : (
        <IconTooltip label={props.titleHint ? `${props.titleHint} · Click to rename` : 'Click to rename'}>
          <span className="nodrag node-title" onClick={beginEdit}>
            <NodeNameLabel name={props.name} label={props.name ? props.title : props.title || UNTITLED} />
          </span>
        </IconTooltip>
      )}

      {props.description && !editing && (
        <span className="node-description" title={props.description}>{props.description}</span>
      )}

      {props.statusChip}

      {props.pill}
      {props.extraHeader}

      <NodeToolbar {...toolbar} />

      {comments}
      {colorOpen && headerRef.current && (
        <NodeColorPicker anchor={headerRef.current} color={props.color} onColor={props.onColor} onClose={() => setColorOpen(false)} />
      )}
    </div>
  )
}
