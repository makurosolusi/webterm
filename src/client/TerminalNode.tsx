import { useRef, useState } from 'react'
import type { NodeProps, Viewport } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome, { termNodeClass } from './NodeChrome'
import FindBar from './FindBar'
import { useSpeechInput } from './useSpeechInput'
import { send } from './ws'
import type { Comment } from '../shared/workspace'

const COLLAPSED_H = 40

export default function TerminalNode({ id, data, selected, height }: NodeProps) {
  const d = data as { cwd?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const termRef = useRef<TerminalHandle>(null)

  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []

  const [searchOpen, setSearchOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const { micActive, toggleMic } = useSpeechInput((text) => send({ t: 'input', id, data: text }))

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)
  const savedVp = useRef<Viewport | null>(null)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const addComment = (text: string) =>
    rf.updateNodeData(id, { comments: [...comments, { id: crypto.randomUUID(), text, ts: Date.now() }] })

  const toggleMaximize = () => {
    if (!maximized) { savedVp.current = rf.getViewport(); rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized(true) }
    else { if (savedVp.current) rf.setViewport(savedVp.current, { duration: 200 }); setMaximized(false) }
  }

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed })}
        style={{ borderTopColor: swatch }}
      >
        <NodeChrome
          title={d.title ?? ''}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments} onAddComment={addComment}
          onRefresh={() => termRef.current?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={toggleMic}
          maximized={maximized} onToggleMaximize={toggleMaximize}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div className="node-body"><TerminalCore ref={termRef} id={id} cwd={d.cwd} /></div>
        {searchOpen && (
          <FindBar
            onSearch={(t, dir) => termRef.current?.search(t, { direction: dir })}
            onClose={() => { setSearchOpen(false); termRef.current?.clearSearch() }}
          />
        )}
      </div>
    </>
  )
}
