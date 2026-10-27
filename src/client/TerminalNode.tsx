import { useRef, useState } from 'react'
import type { NodeProps, Viewport } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome from './NodeChrome'
import FindBar from './FindBar'
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
  const [micActive, setMicActive] = useState(false)
  const [maximized, setMaximized] = useState(false)

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)
  const savedVp = useRef<Viewport | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API belum ada di lib.dom TS
  const recogRef = useRef<any>(null)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const addComment = (text: string) =>
    rf.updateNodeData(id, { comments: [...comments, { id: crypto.randomUUID(), text, ts: Date.now() }] })

  const toggleMic = () => {
    if (micActive) { recogRef.current?.stop(); return }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API belum ada di lib.dom TS
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition
    if (!SR) return
    const recog = new SR()
    recog.continuous = false
    recog.interimResults = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SpeechRecognitionEvent belum ada di lib.dom TS
    recog.onresult = (e: any) => {
      const transcript = e.results?.[0]?.[0]?.transcript
      if (transcript) send({ t: 'input', id, data: transcript })
    }
    recog.onend = () => setMicActive(false)
    recog.onerror = () => setMicActive(false)
    recogRef.current = recog
    recog.start()
    setMicActive(true)
  }

  const toggleMaximize = () => {
    if (!maximized) { savedVp.current = rf.getViewport(); rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized(true) }
    else { if (savedVp.current) rf.setViewport(savedVp.current, { duration: 200 }); setMaximized(false) }
  }

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={`term-node${selected ? ' term-node--selected' : ''}${collapsed ? ' term-node--collapsed' : ''}`}
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
