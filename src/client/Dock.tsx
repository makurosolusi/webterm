import { useEffect, useState } from 'react'
import {
  Plus, Minus, Undo2, Redo2, ChevronLeft, ChevronRight, Scan, LayoutGrid,
  Save, Layers, Mic, SquareTerminal, FolderPlus, Check, Lock, LockOpen, PanelLeft, Focus, Inbox,
  MessageSquare,
} from 'lucide-react'
import { BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR, agentConfig, assembleCmd } from '../shared/workspace'
import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { CustomAgent } from '../shared/settings'
import { formatInboxBadge } from './inboxDockState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export interface DockProps {
  onAddTerminal: () => void
  onAddAgent: (cmd: string, agentId: AgentId, cwd?: string) => void
  onCreateWorkspace: (name: string, cwd?: string) => void
  onBrowse: (onPick: (p: string) => void) => void
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean
  onBack: () => void; onForward: () => void; canBack: boolean; canForward: boolean
  onFit: () => void
  onToggleBoard: () => void
  /** Panel Sessions terbuka? Tombol pembukanya hidup DI SINI, dan ini satu-satunya keadaan panel
   *  yang dock perlu tahu: hanya untuk menyalakan tombolnya (`active`/`aria-pressed`/title). Letak
   *  plat tidak lagi ikut berubah — dock diam, panel yang minggir (lihat `.dock` di dock.css). */
  sessionsOpen: boolean
  onToggleSessions: () => void
  /** Inbox terbuka? Tombolnya duduk SEBARIS dengan Sessions: dua-duanya permukaan yang mengapung
   *  di atas canvas, bukan aksi pada node. */
  inboxOpen: boolean
  onToggleInbox: () => void
  /** Chat panel terbuka? Opsional supaya pemakaian Dock lama (dan test-nya) tetap valid:
   *  tombolnya hanya dirender ketika integrator menyediakan handler. Panel Chat adalah sibling
   *  Inbox/Sessions — permukaan yang mengapung di atas canvas, bukan node. */
  chatOpen?: boolean
  onToggleChat?: () => void
  /** Item yang menunggu operator. 0 = tidak ada badge. Angkanya datang dari `useInboxBadge`;
   *  dock tidak pernah memanggil `fetch` sendiri. */
  inboxUnread?: number
  zoomPct: number; onZoomIn: () => void; onZoomOut: () => void
  /** Zoom ke persen absolut. Tanpa ini readout zoom cuma teks, bukan menu preset. */
  onZoomTo?: (pct: number) => void
  /** Kunci PANDANGAN (pan/zoom) sementara node tetap bisa digeser — semantik nodeterm, kebalikan
   *  dari `showInteractive` bawaan React Flow yang justru mematikan drag node. Props-driven karena
   *  pemanggil menyetel panOnDrag/panOnScroll/zoomOnPinch dari state yang sama. */
  locked: boolean
  onToggleLock: () => void
  /** Clean view menyala? Tombol ini SATU-SATUNYA jalan masuk lewat mouse; jalan keluarnya chord
   *  ⌘./Ctrl+. karena dock ini sendiri ikut tersembunyi di sana (lihat `cleanView.tsx`). Karena
   *  itu `aria-pressed`-nya praktis selalu 'false' saat terlihat — ia tetap ditulis supaya keadaan
   *  tombolnya benar bagi pembaca layar yang menyusuri DOM yang disembunyikan CSS. */
  cleanView: boolean
  onToggleCleanView: () => void
  onSave?: () => void; dirty?: boolean
  onLayouts?: () => void
  micActive?: boolean; onToggleMic?: () => void
  /** Dari settings; tombolnya hilang dari menu Add. Prop, bukan store — integrator yang menyambung. */
  disabledAgents?: AgentId[]
  customAgents?: CustomAgent[]
  /** Override perintah peluncuran per builtin (mis. skrip pemilih akun). Hanya builtin: agent
   *  custom sudah membawa `launchCmd`-nya sendiri. */
  agentLaunchCommands?: Partial<Record<BuiltinAgentId, string>>
}

/** Preset zoom dock, disalin dari nodeterm `src/renderer/lib/zoomPresets.ts`. */
export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const

const ICON = 16

export default function Dock(props: DockProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')

  const disabled = props.disabledAgents ?? DEFAULT_SETTINGS.disabledAgents
  const customs = props.customAgents ?? DEFAULT_SETTINGS.customAgents
  const launchCmds = props.agentLaunchCommands ?? DEFAULT_SETTINGS.agentLaunchCommands
  const builtins = BUILTIN_AGENT_IDS.filter((a) => !disabled.includes(a))
  const visibleCustoms = customs.filter((c) => !disabled.includes(c.id))

  const badge = formatInboxBadge(props.inboxUnread ?? 0)

  useEffect(() => {
    if (!addOpen && !workspaceOpen && !zoomOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAddOpen(false)
      setWorkspaceOpen(false)
      setZoomOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addOpen, workspaceOpen, zoomOpen])

  const close = () => setWorkspaceOpen(false)

  const addBuiltin = (id: BuiltinAgentId) => {
    // cwd dibiarkan undefined: server memakai cwd workspace, sama seperti nodeterm yang
    // menambah agent dengan satu klik tanpa form.
    props.onAddAgent(assembleCmd(id, launchCmds[id]), id)
    setAddOpen(false)
  }

  const addTerminal = () => {
    props.onAddTerminal()
    setAddOpen(false)
  }

  const addCustom = (agent: CustomAgent) => {
    props.onAddAgent(agent.launchCmd, agent.id)
    setAddOpen(false)
  }

  const createWs = () => {
    if (!wsName.trim()) return
    props.onCreateWorkspace(wsName.trim(), wsCwd.trim() || undefined)
    setWsName(''); setWsCwd(''); close()
  }

  const openWorkspaceForm = () => {
    setAddOpen(false)
    setWorkspaceOpen(true)
  }

  return (
    <>
      <div className="dock">
        {/* Di ujung ATAS kolom, dipisah dari sisanya: kelompok tombol yang membuka permukaan
            lain alih-alih bekerja pada canvas. */}
        <Button
          className={`dock-btn${props.sessionsOpen ? ' active' : ''}`}
          aria-label="Toggle sessions panel"
          title={props.sessionsOpen ? 'Hide sessions' : 'Show sessions'}
          aria-pressed={props.sessionsOpen}
          onClick={props.onToggleSessions}
        ><PanelLeft size={ICON} /></Button>

        {/* Badge hanya informasi: satu klik membuka panel, tidak pernah menyetujui apa pun.
            Persetujuan tetap lewat dialog eksplisit di dalam panel. */}
        <Button
          className={`dock-btn${props.inboxOpen ? ' active' : ''}`}
          aria-label={badge ? `Toggle inbox panel (${badge} unread)` : 'Toggle inbox panel'}
          title={props.inboxOpen ? 'Hide inbox' : 'Show inbox (i)'}
          aria-pressed={props.inboxOpen}
          onClick={props.onToggleInbox}
        >
          <Inbox size={ICON} />
          {badge && <span className="dock-badge" aria-hidden="true">{badge}</span>}
        </Button>

        {/* Chat is a third floating surface, not a canvas node: a conversation needs a stable
            keyboard focus and a chronological log, which a node loses off-viewport. */}
        {props.onToggleChat && (
          <Button
            className={`dock-btn${props.chatOpen ? ' active' : ''}`}
            aria-label="Toggle chat panel"
            title={props.chatOpen ? 'Hide chat' : 'Show chat'}
            aria-pressed={props.chatOpen === true}
            onClick={props.onToggleChat}
          ><MessageSquare size={ICON} /></Button>
        )}

        <Separator className="dock-sep" />

        <div className="dock-slot">
          <Button className="dock-btn dock-add" aria-label="Add node" title="Add node" onClick={() => setAddOpen(true)}><Plus size={ICON} /></Button>
        </div>
        {addOpen && (
          <Dialog open onOpenChange={setAddOpen}>
            <DialogContent className="dock-add-dialog">
              <DialogHeader><DialogTitle>Add node</DialogTitle></DialogHeader>
              <div className="dock-add-list">
                <Button variant="ghost" className="dock-action-row" onClick={addTerminal}><SquareTerminal size={ICON} /> Terminal</Button>
                {builtins.map((a) => {
                  const cfg = agentConfig(a)
                  return <Button key={a} variant="ghost" className="dock-action-row" title={cfg?.notice} onClick={() => addBuiltin(a)}><span className="dock-menu__glyph" style={{ background: cfg?.color ?? FALLBACK_AGENT_COLOR }} />{cfg?.label ?? a}</Button>
                })}
                {visibleCustoms.map((c) => <Button key={c.id} variant="ghost" className="dock-action-row" onClick={() => addCustom(c)}><span className="dock-menu__glyph" style={{ background: c.color ?? FALLBACK_AGENT_COLOR }} />{c.label}</Button>)}
                <Button variant="ghost" className="dock-action-row" onClick={openWorkspaceForm}><FolderPlus size={ICON} /> Workspace…</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {workspaceOpen && (
          <Dialog open onOpenChange={setWorkspaceOpen}>
          <DialogContent className="dock-workspace-dialog">
            <DialogHeader><DialogTitle>Create workspace</DialogTitle></DialogHeader>
            <div className="dock-menu__form">
              <Input placeholder="name" autoFocus value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createWs() }} />
              <div className="dock-menu__form-row">
                <Input style={{ flex: 1 }} placeholder="cwd (optional)" value={wsCwd}
                  onChange={(e) => setWsCwd(e.target.value)} />
                <Button variant="ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</Button>
              </div>
              <Button onClick={createWs}>Create</Button>
            </div>
          </DialogContent>
          </Dialog>
        )}

        <Separator className="dock-sep" />

        <Button className="dock-btn" title="Undo" onClick={props.onUndo} disabled={!props.canUndo}><Undo2 size={ICON} /></Button>
        <Button className="dock-btn" title="Redo" onClick={props.onRedo} disabled={!props.canRedo}><Redo2 size={ICON} /></Button>
        <Button className="dock-btn" title="Go back" onClick={props.onBack} disabled={!props.canBack}><ChevronLeft size={ICON} /></Button>
        <Button className="dock-btn" title="Go forward" onClick={props.onForward} disabled={!props.canForward}><ChevronRight size={ICON} /></Button>

        <Separator className="dock-sep" />

        {props.onSave && (
          <Button className="dock-btn" title="Save layout" onClick={props.onSave}>
            <Save size={ICON} />
            <span className={`dock-dirty${props.dirty ? ' dirty' : ''}`} />
          </Button>
        )}
        <Button className="dock-btn" aria-label="Fit view" title="Fit view" onClick={props.onFit}><Scan size={ICON} /></Button>
        {props.onLayouts && (
          <Button className="dock-btn" title="Layouts" onClick={props.onLayouts}><Layers size={ICON} /></Button>
        )}
        <Button className="dock-btn" title="Board" onClick={props.onToggleBoard}><LayoutGrid size={ICON} /></Button>
        {props.onToggleMic && (
          <Button
            className={`dock-btn${props.micActive ? ' active' : ''}`}
            title="Dictate" onClick={props.onToggleMic}
          ><Mic size={ICON} /></Button>
        )}

        <Separator className="dock-sep" />

        <Button className="dock-btn" aria-label="Zoom out" title="Zoom out" onClick={props.onZoomOut}><Minus size={ICON} /></Button>
        <div className="dock-slot">
          {props.onZoomTo ? (
            <>
              <Button className="dock-zoom" title="Zoom presets" onClick={() => setZoomOpen(true)}>{props.zoomPct}%</Button>
              {zoomOpen && (
                <Dialog open onOpenChange={setZoomOpen}>
                <DialogContent className="dock-zoom-dialog">
                  <DialogHeader><DialogTitle>Zoom</DialogTitle></DialogHeader>
                  <div className="dock-zoom-list">
                    {ZOOM_PRESETS.map((p) => <Button key={p} variant={p === props.zoomPct ? 'secondary' : 'ghost'} className="dock-action-row" onClick={() => { props.onZoomTo?.(p); setZoomOpen(false) }}><span className="dock-menu__check">{p === props.zoomPct && <Check size={13} />}</span>{p}%</Button>)}
                  </div>
                </DialogContent>
                </Dialog>
              )}
            </>
          ) : (
            <span className="dock-zoom">{props.zoomPct}%</span>
          )}
        </div>
        <Button className="dock-btn" aria-label="Zoom in" title="Zoom in" onClick={props.onZoomIn}><Plus size={ICON} /></Button>

        {/* SATU separator sebelum lock, alasan yang sama seperti di rail lama: zoom in/out/fit
            semuanya gerakan kamera, lock adalah toggle mode dan satu-satunya yang mengubah apa
            yang boleh dilakukan tiga lainnya. */}
        <Separator className="dock-sep" />

        <Button
          className={`dock-btn${props.locked ? ' active' : ''}`}
          aria-label={props.locked ? 'Unlock view' : 'Lock view'}
          title={props.locked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom); nodes stay movable'}
          aria-pressed={props.locked}
          onClick={props.onToggleLock}
        >{props.locked ? <Lock size={ICON} /> : <LockOpen size={ICON} />}</Button>

        {/* Bersebelahan dengan lock, kelompok yang sama: dua-duanya toggle MODE, bukan gerakan
            kamera. */}
        <Button
          className={`dock-btn${props.cleanView ? ' active' : ''}`}
          aria-label="Clean view"
          title="Clean view — hide all chrome (⌘./Ctrl+. to exit)"
          aria-pressed={props.cleanView}
          onClick={props.onToggleCleanView}
        ><Focus size={ICON} /></Button>
      </div>
    </>
  )
}
