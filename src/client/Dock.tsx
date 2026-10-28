import { useState } from 'react'
import {
  Plus, Minus, Undo2, Redo2, ChevronLeft, ChevronRight, Scan, LayoutGrid,
  Save, Layers, Mic, SquareTerminal, FolderPlus, Check,
} from 'lucide-react'
import { BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR, agentConfig, assembleCmd } from '../shared/workspace'
import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { CustomAgent } from '../shared/settings'

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
  /** Zoom ke persen absolut. Tanpa ini readout zoom cuma teks, bukan menu preset. */
  onZoomTo?: (pct: number) => void
  onSave?: () => void; dirty?: boolean
  onLayouts?: () => void
  micActive?: boolean; onToggleMic?: () => void
  /** Dari settings; tombolnya hilang dari menu Add. Prop, bukan store — integrator yang menyambung. */
  disabledAgents?: AgentId[]
  customAgents?: CustomAgent[]
}

/** Preset zoom dock, disalin dari nodeterm `src/renderer/lib/zoomPresets.ts`. */
export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const

const ICON = 16

export default function Dock(props: DockProps) {
  const [menu, setMenu] = useState<'add' | 'workspace' | 'zoom' | null>(null)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')

  const disabled = props.disabledAgents ?? DEFAULT_SETTINGS.disabledAgents
  const customs = props.customAgents ?? DEFAULT_SETTINGS.customAgents
  const builtins = BUILTIN_AGENT_IDS.filter((a) => !disabled.includes(a))
  const visibleCustoms = customs.filter((c) => !disabled.includes(c.id))

  const close = () => setMenu(null)

  const addBuiltin = (id: BuiltinAgentId) => {
    // cwd dibiarkan undefined: server memakai cwd workspace, sama seperti nodeterm yang
    // menambah agent dengan satu klik tanpa form.
    props.onAddAgent(assembleCmd(id), id)
    close()
  }

  const createWs = () => {
    if (!wsName.trim()) return
    props.onCreateWorkspace(wsName.trim(), wsCwd.trim() || undefined)
    setWsName(''); setWsCwd(''); close()
  }

  return (
    <>
      {menu && <div className="dock-backdrop" onClick={close} />}
      <div className="dock">
        <div className="dock-slot">
          {menu === 'add' && (
            <div className="dock-menu dock-add-menu">
              <div className="dock-menu__list">
                <button onClick={() => { props.onAddTerminal(); close() }}>
                  <SquareTerminal size={ICON} /> Terminal
                </button>
                <div className="dock-menu__rule" />
                {builtins.map((a) => {
                  const cfg = agentConfig(a)
                  return (
                    <button key={a} title={cfg?.notice} onClick={() => addBuiltin(a)}>
                      <span className="dock-menu__glyph" style={{ background: cfg?.color ?? FALLBACK_AGENT_COLOR }} />
                      {cfg?.label ?? a}
                    </button>
                  )
                })}
                {visibleCustoms.length > 0 && <div className="dock-menu__rule" />}
                {visibleCustoms.map((c) => (
                  <button key={c.id} onClick={() => { props.onAddAgent(c.launchCmd, c.id); close() }}>
                    <span className="dock-menu__glyph" style={{ background: c.color ?? FALLBACK_AGENT_COLOR }} />
                    {c.label}
                  </button>
                ))}
                <div className="dock-menu__rule" />
                <button onClick={() => setMenu('workspace')}>
                  <FolderPlus size={ICON} /> Workspace…
                </button>
              </div>
            </div>
          )}

          {menu === 'workspace' && (
            <div className="dock-menu dock-menu__form">
              <input className="field" placeholder="name" autoFocus value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createWs() }} />
              <div className="dock-menu__form-row">
                <input className="field" style={{ flex: 1 }} placeholder="cwd (optional)" value={wsCwd}
                  onChange={(e) => setWsCwd(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</button>
              </div>
              <button className="btn btn--accent" onClick={createWs}>Create</button>
            </div>
          )}

          <button
            className={`dock-btn dock-add${menu === 'add' ? ' active' : ''}`}
            title="Add node" onClick={() => setMenu((m) => (m ? null : 'add'))}
          ><Plus size={ICON} /></button>
        </div>

        <div className="dock-sep" />

        <button className="dock-btn" title="Undo" onClick={props.onUndo} disabled={!props.canUndo}><Undo2 size={ICON} /></button>
        <button className="dock-btn" title="Redo" onClick={props.onRedo} disabled={!props.canRedo}><Redo2 size={ICON} /></button>
        <button className="dock-btn" title="Go back" onClick={props.onBack} disabled={!props.canBack}><ChevronLeft size={ICON} /></button>
        <button className="dock-btn" title="Go forward" onClick={props.onForward} disabled={!props.canForward}><ChevronRight size={ICON} /></button>

        <div className="dock-sep" />

        {props.onSave && (
          <button className="dock-btn" title="Save layout" onClick={props.onSave}>
            <Save size={ICON} />
            <span className={`dock-dirty${props.dirty ? ' dirty' : ''}`} />
          </button>
        )}
        <button className="dock-btn" title="Fit view" onClick={props.onFit}><Scan size={ICON} /></button>
        {props.onLayouts && (
          <button className="dock-btn" title="Layouts" onClick={props.onLayouts}><Layers size={ICON} /></button>
        )}
        <button className="dock-btn" title="Board" onClick={props.onToggleBoard}><LayoutGrid size={ICON} /></button>
        {props.onToggleMic && (
          <button
            className={`dock-btn${props.micActive ? ' active' : ''}`}
            title="Dictate" onClick={props.onToggleMic}
          ><Mic size={ICON} /></button>
        )}

        <div className="dock-sep" />

        <button className="dock-btn" title="Zoom out" onClick={props.onZoomOut}><Minus size={ICON} /></button>
        <div className="dock-slot">
          {menu === 'zoom' && props.onZoomTo && (
            <div className="dock-menu dock-zoom-menu">
              {ZOOM_PRESETS.map((p) => (
                <button
                  key={p} className={p === props.zoomPct ? 'is-current' : undefined}
                  onClick={() => { props.onZoomTo?.(p); close() }}
                >
                  <span className="dock-menu__check">{p === props.zoomPct && <Check size={13} />}</span>
                  {p}%
                </button>
              ))}
            </div>
          )}
          {props.onZoomTo ? (
            <button
              className={`dock-zoom${menu === 'zoom' ? ' active' : ''}`}
              title="Zoom presets" onClick={() => setMenu((m) => (m === 'zoom' ? null : 'zoom'))}
            >{props.zoomPct}%</button>
          ) : (
            <span className="dock-zoom">{props.zoomPct}%</span>
          )}
        </div>
        <button className="dock-btn" title="Zoom in" onClick={props.onZoomIn}><Plus size={ICON} /></button>
      </div>
    </>
  )
}
