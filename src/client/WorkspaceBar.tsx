import { useState } from 'react'
import { AGENTS, assembleCmd } from '../shared/workspace'
import type { AgentId, Workspace } from '../shared/workspace'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreateWorkspace: (name: string, cwd?: string) => void
  onAddTerminal: () => void
  onAddAgent: (cmd: string, agentId: AgentId, cwd?: string) => void
  onToggleBoard: () => void
  onBrowse: (onPick: (path: string) => void) => void
}

const bar: React.CSSProperties = {
  position: 'absolute', zIndex: 10, top: 12, left: 12,
  display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
}
const btn: React.CSSProperties = {
  padding: '8px 14px', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
}
const field: React.CSSProperties = {
  padding: '6px 8px', background: '#1e1e1e', color: '#eee',
  border: '1px solid #333', borderRadius: 6, fontSize: 13,
}
const panel: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  background: '#181818', padding: 10, borderRadius: 6, border: '1px solid #333',
}

const browseBtn: React.CSSProperties = {
  padding: '6px 8px', background: '#2a2a2a', color: '#eee',
  border: '1px solid #333', borderRadius: 6, cursor: 'pointer', fontSize: 12,
}

const AGENT_IDS: AgentId[] = [...(Object.keys(AGENTS) as Exclude<AgentId, 'custom'>[]), 'custom']

export default function WorkspaceBar({ workspaces, activeId, onSelect, onCreateWorkspace, onAddTerminal, onAddAgent, onToggleBoard, onBrowse }: Props) {
  const [showWs, setShowWs] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')

  const [showAgent, setShowAgent] = useState(false)
  const [agentId, setAgentId] = useState<AgentId>('claude')
  const [profile, setProfile] = useState('')
  const [agentCwd, setAgentCwd] = useState('')
  const [customCmd, setCustomCmd] = useState('')

  const createWs = () => {
    if (!wsName.trim()) return
    onCreateWorkspace(wsName.trim(), wsCwd.trim() || undefined)
    setWsName(''); setWsCwd(''); setShowWs(false)
  }

  const addAgent = () => {
    const cmd = agentId === 'custom' ? customCmd.trim() : assembleCmd(agentId, profile.trim() || undefined)
    if (!cmd) return
    onAddAgent(cmd, agentId, agentCwd.trim() || undefined)
    setProfile(''); setAgentCwd(''); setCustomCmd(''); setShowAgent(false)
  }

  return (
    <div style={bar}>
      <select style={field} value={activeId ?? ''} onChange={(e) => onSelect(e.target.value)}>
        {workspaces.length === 0 && <option value="">(no workspaces)</option>}
        {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>

      <button style={btn} onClick={() => setShowWs((v) => !v)}>+ Workspace</button>
      <button style={btn} onClick={onAddTerminal}>+ Terminal</button>
      <button style={btn} onClick={() => setShowAgent((v) => !v)}>+ Agent</button>
      <button style={btn} onClick={onToggleBoard}>Board</button>

      {showWs && (
        <div style={panel}>
          <input style={field} placeholder="name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <input style={{ ...field, flex: 1 }} placeholder="cwd (optional)" value={wsCwd} onChange={(e) => setWsCwd(e.target.value)} />
            <button style={browseBtn} onClick={() => onBrowse(setWsCwd)}>Browse</button>
          </div>
          <button style={btn} onClick={createWs}>Create</button>
        </div>
      )}

      {showAgent && (
        <div style={panel}>
          <select style={field} value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)}>
            {AGENT_IDS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {agentId === 'custom' ? (
            <input style={field} placeholder="custom command" value={customCmd} onChange={(e) => setCustomCmd(e.target.value)} />
          ) : (
            <input style={field} placeholder="envman profile (optional)" value={profile} onChange={(e) => setProfile(e.target.value)} />
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <input style={{ ...field, flex: 1 }} placeholder="cwd (optional)" value={agentCwd} onChange={(e) => setAgentCwd(e.target.value)} />
            <button style={browseBtn} onClick={() => onBrowse(setAgentCwd)}>Browse</button>
          </div>
          <button style={btn} onClick={addAgent}>Add</button>
        </div>
      )}
    </div>
  )
}
