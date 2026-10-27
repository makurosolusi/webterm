import { useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { NodeResizer } from '@xyflow/react'
import { AGENTS } from '../shared/workspace'
import type { AgentId, AgentStatus } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import { send, subscribeStatus, getStatus } from './ws'

export default function AgentNode({ data, selected }: NodeProps) {
  const { id, cmd, cwd, agentId, color, title, sessionId, onSession } = data as {
    id: string; cmd?: string; cwd?: string; agentId?: AgentId; color?: string; title?: string
    sessionId?: string; onSession?: (id: string, uuid: string) => void
  }

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
  const swatch = color ?? builtin?.color ?? '#888'
  const label = title ?? builtin?.label ?? agentId ?? 'agent'

  // Restart kills the PTY and mints a NEW uuid (claude can't reuse a --session-id).
  const restart = () => {
    send({ t: 'close', id })
    const n = crypto.randomUUID()
    setSid(n); setResume(false); onSession?.(id, n); setGen((g) => g + 1)
  }
  // Resume reattaches claude's prior session via the SAME uuid + --resume.
  const doResume = () => { setResume(true); setGen((g) => g + 1) }

  const canResume = agentId === 'claude' && status === 'done'

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={240} minHeight={160} color={swatch} />
      <div className={`term-node${selected ? ' term-node--selected' : ''}`} style={{ borderTopColor: swatch }}>
        <div className="node-header">
          <span className="node-swatch" style={{ background: swatch }} />
          <span className="node-title">{label}</span>
          <span
            title={status ?? 'unknown'}
            className={status ? `node-status node-status--${status}` : 'node-status'}
          />
          {canResume && (
            <button className="nodrag icon-btn" onClick={doResume} style={{ width: 'auto', padding: '0 6px', fontSize: 10 }}>
              Resume
            </button>
          )}
          <button className="nodrag icon-btn" onClick={restart} style={{ width: 'auto', padding: '0 6px', fontSize: 10 }}>
            Restart
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TerminalCore
            key={gen}
            id={id}
            cmd={cmd}
            cwd={cwd}
            agentId={agentId}
            sessionId={agentId === 'claude' ? sid : undefined}
            resume={resume}
          />
        </div>
      </div>
    </>
  )
}
