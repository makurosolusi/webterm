import { useEffect, useRef, useState } from 'react'
import type { NodeProps, Viewport } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { AGENTS } from '../shared/workspace'
import type { AgentId, AgentStatus, Comment } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome from './NodeChrome'
import UsagePill from './UsagePill'
import FindBar from './FindBar'
import { send, subscribeStatus, getStatus } from './ws'

const COLLAPSED_H = 40

export default function AgentNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    cmd?: string; cwd?: string; agentId?: AgentId; color?: string; title?: string
    sessionId?: string; collapsed?: boolean; comments?: Comment[]
    onSession?: (id: string, uuid: string) => void
  }
  const { cmd, cwd, agentId, sessionId, onSession } = d
  const rf = useReactFlow()
  const termRef = useRef<TerminalHandle>(null)

  const [status, setStatus] = useState<AgentStatus | undefined>(() => getStatus(id))
  useEffect(() => subscribeStatus((sid, s) => { if (sid === id) setStatus(s) }), [id])

  // Pre-generated session UUID enables claude --session-id (and later --resume).
  const [sid, setSid] = useState<string>(sessionId ?? crypto.randomUUID())
  const [resume, setResume] = useState(false)
  // Bumping the key remounts TerminalCore so it re-sends `open`.
  const [gen, setGen] = useState(0)

  // Persist a freshly generated id up to App exactly once.
  useEffect(() => { if (!sessionId) onSession?.(id, sid) }, [])

  const builtin = agentId && agentId !== 'custom' ? AGENTS[agentId] : undefined
  const swatch = d.color ?? builtin?.color ?? '#0a84ff'
  const label = d.title ?? builtin?.label ?? agentId ?? 'agent'
  const collapsed = d.collapsed ?? false
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

  // Restart kills the PTY and mints a NEW uuid (claude can't reuse a --session-id).
  const restart = () => {
    send({ t: 'close', id })
    const n = crypto.randomUUID()
    setSid(n); setResume(false); onSession?.(id, n); setGen((g) => g + 1)
  }
  // Resume reattaches claude's prior session via the SAME uuid + --resume.
  const doResume = () => { setResume(true); setGen((g) => g + 1) }
  const canResume = agentId === 'claude' && status === 'done'

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

  // Agent-only toolbar props are filled by B3/Wave C; undefined now → buttons stay hidden.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passthrough of not-yet-wired handlers
  const ext = data as any

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={`term-node${selected ? ' term-node--selected' : ''}${collapsed ? ' term-node--collapsed' : ''}`}
        style={{ borderTopColor: swatch }}
      >
        <NodeChrome
          title={label}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          status={status}
          pill={<UsagePill modelLabel={label} />}
          comments={comments} onAddComment={addComment}
          onRefresh={() => termRef.current?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={toggleMic}
          maximized={maximized} onToggleMaximize={toggleMaximize}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
          onAiName={ext.onAiName} aiNaming={ext.aiNaming}
          onBroadcast={ext.onBroadcast} broadcastActive={ext.broadcastActive} broadcastDisabled={ext.broadcastDisabled}
          hideLinks={ext.hideLinks} onToggleHideLinks={ext.onToggleHideLinks}
          extraHeader={
            <>
              {canResume && (
                <button className="nodrag icon-btn" onClick={doResume} style={{ width: 'auto', padding: '0 6px', fontSize: 10 }}>Resume</button>
              )}
              <button className="nodrag icon-btn" onClick={restart} style={{ width: 'auto', padding: '0 6px', fontSize: 10 }}>Restart</button>
            </>
          }
        />
        <div className="node-body">
          <TerminalCore
            key={gen}
            ref={termRef}
            id={id}
            cmd={cmd}
            cwd={cwd}
            agentId={agentId}
            sessionId={agentId === 'claude' ? sid : undefined}
            resume={resume}
          />
        </div>
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
