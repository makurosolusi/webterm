import { useState } from 'react'
import { AGENTS, assembleCmd, isBuiltinAgent } from '../shared/workspace'
import type { AgentId } from '../shared/workspace'

export interface DockProps {
  onAddTerminal: () => void
  onAddAgent: (cmd: string, agentId: AgentId, cwd?: string) => void
  onCreateWorkspace: (name: string, cwd?: string) => void
  onBrowse: (onPick: (p: string) => void) => void
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean
  onBack: () => void; onForward: () => void; canBack: boolean; canForward: boolean
  onFit: () => void
  onToggleBoard: () => void
  zoomPct: number; onZoomIn: () => void; onZoomOut: () => void
}

const AGENT_IDS: AgentId[] = [...(Object.keys(AGENTS) as Exclude<AgentId, 'custom'>[]), 'custom']

type Svg = React.SVGProps<SVGSVGElement>
const svg = (children: React.ReactNode) => (p: Svg) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>{children}</svg>
)
const IconPlus = svg(<path d="M8 3v10M3 8h10" />)
const IconUndo = svg(<><path d="M4 8h7a3 3 0 0 1 0 6H8" /><path d="M6.5 5.5 4 8l2.5 2.5" /></>)
const IconRedo = svg(<><path d="M12 8H5a3 3 0 0 0 0 6h3" /><path d="M9.5 5.5 12 8l-2.5 2.5" /></>)
const IconBack = svg(<path d="M10 4 6 8l4 4" />)
const IconForward = svg(<path d="M6 4l4 4-4 4" />)
const IconFit = svg(<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />)
const IconBoard = svg(<path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" />)
const IconMinus = svg(<path d="M3 8h10" />)

export default function Dock(props: DockProps) {
  const [mode, setMode] = useState<'menu' | 'agent' | 'workspace' | null>(null)
  const [agentId, setAgentId] = useState<AgentId>('claude')
  const [profile, setProfile] = useState('')
  const [customCmd, setCustomCmd] = useState('')
  const [agentCwd, setAgentCwd] = useState('')
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')

  const addAgent = () => {
    const cmd = isBuiltinAgent(agentId) ? assembleCmd(agentId, profile.trim() || undefined) : customCmd.trim()
    if (!cmd) return
    props.onAddAgent(cmd, agentId, agentCwd.trim() || undefined)
    setProfile(''); setCustomCmd(''); setAgentCwd(''); setMode(null)
  }

  const createWs = () => {
    if (!wsName.trim()) return
    props.onCreateWorkspace(wsName.trim(), wsCwd.trim() || undefined)
    setWsName(''); setWsCwd(''); setMode(null)
  }

  return (
    <div className="dock">
      <div style={{ position: 'relative', display: 'flex' }}>
        <button className="dock-btn" title="Add" onClick={() => setMode((m) => (m ? null : 'menu'))}><IconPlus /></button>

        {mode === 'menu' && (
          <div className="dock-flyout">
            <button className="dock-flyout-item" onClick={() => { props.onAddTerminal(); setMode(null) }}>Terminal</button>
            <button className="dock-flyout-item" onClick={() => setMode('agent')}>Agent</button>
            <button className="dock-flyout-item" onClick={() => setMode('workspace')}>Workspace</button>
          </div>
        )}

        {mode === 'agent' && (
          <div className="dock-flyout" style={{ minWidth: 240, gap: 6 }}>
            <select className="field" value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)}>
              {AGENT_IDS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {agentId === 'custom' ? (
              <input className="field" placeholder="custom command" value={customCmd} onChange={(e) => setCustomCmd(e.target.value)} />
            ) : (
              <input className="field" placeholder="envman profile (optional)" value={profile} onChange={(e) => setProfile(e.target.value)} />
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field" style={{ flex: 1 }} placeholder="cwd (optional)" value={agentCwd} onChange={(e) => setAgentCwd(e.target.value)} />
              <button className="btn btn--ghost" onClick={() => props.onBrowse(setAgentCwd)}>Browse</button>
            </div>
            <button className="btn btn--accent" onClick={addAgent}>Add</button>
          </div>
        )}

        {mode === 'workspace' && (
          <div className="dock-flyout" style={{ minWidth: 240, gap: 6 }}>
            <input className="field" placeholder="name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="field" style={{ flex: 1 }} placeholder="cwd (optional)" value={wsCwd} onChange={(e) => setWsCwd(e.target.value)} />
              <button className="btn btn--ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</button>
            </div>
            <button className="btn btn--accent" onClick={createWs}>Create</button>
          </div>
        )}
      </div>

      <div className="dock-sep" />

      <button className="dock-btn" title="Undo" onClick={props.onUndo} disabled={!props.canUndo}><IconUndo /></button>
      <button className="dock-btn" title="Redo" onClick={props.onRedo} disabled={!props.canRedo}><IconRedo /></button>
      <button className="dock-btn" title="Back" onClick={props.onBack} disabled={!props.canBack}><IconBack /></button>
      <button className="dock-btn" title="Forward" onClick={props.onForward} disabled={!props.canForward}><IconForward /></button>

      <div className="dock-sep" />

      <button className="dock-btn" title="Fit view" onClick={props.onFit}><IconFit /></button>
      <button className="dock-btn" title="Board" onClick={props.onToggleBoard}><IconBoard /></button>

      <div className="dock-sep" />

      <button className="dock-btn" title="Zoom out" onClick={props.onZoomOut}><IconMinus /></button>
      <span className="dock-zoom">{props.zoomPct}%</span>
      <button className="dock-btn" title="Zoom in" onClick={props.onZoomIn}><IconPlus /></button>
    </div>
  )
}
