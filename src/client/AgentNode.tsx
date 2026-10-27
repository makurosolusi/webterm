import { useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { AGENTS } from '../shared/workspace'
import type { AgentId, AgentStatus } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import { send, subscribeStatus, getStatus } from './ws'

const DOT: Record<AgentStatus, string> = { working: '#22c55e', waiting: '#eab308', blocked: '#ef4444', done: '#6b7280' }

export default function AgentNode({ data }: NodeProps) {
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
  const dotColor = status ? DOT[status] : '#555'

  return (
    <div style={{ width: 480, height: 320, background: '#1e1e1e', borderRadius: 6, overflow: 'hidden', border: '1px solid #333' }}>
      <div style={{ height: 24, background: '#2a2a2a', color: '#ccc', fontSize: 11, lineHeight: '24px', padding: '0 8px', fontFamily: 'monospace', cursor: 'grab', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: swatch, flex: '0 0 auto' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span
          title={status ?? 'unknown'}
          style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor, flex: '0 0 auto' }}
        />
        {canResume && (
          <button
            className="nodrag"
            onClick={doResume}
            style={{ background: '#444', color: '#eee', border: 'none', borderRadius: 4, fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
          >
            Resume
          </button>
        )}
        <button
          className="nodrag"
          onClick={restart}
          style={{ background: '#444', color: '#eee', border: 'none', borderRadius: 4, fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
        >
          Restart
        </button>
      </div>
      <div style={{ height: 'calc(100% - 24px)', width: '100%' }}>
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
  )
}
