import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR, agentConfig, assembleCmd } from '../shared/workspace'
import type { AgentId, BuiltinAgentId } from '../shared/workspace'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { CustomAgent } from '../shared/settings'
import { VscodeActivityBar } from '@/components/vscode/vscodeActivityBar'
import type { VscodeActivityBarItem } from '@/components/vscode/vscodeActivityBar'
import { VscodeStatusBar } from '@/components/vscode/vscodeStatusBar'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  /** Kanban terbuka? Hanya untuk menandai item `Board` di activity bar. */
  boardOpen?: boolean
  /** Panel Sessions terbuka? Item `Sessions` di activity bar mengikuti keadaan ini. */
  sessionsOpen: boolean
  onToggleSessions: () => void
  /** Inbox terbuka? Item `Inbox` duduk sebaris dengan Sessions di activity bar. */
  inboxOpen: boolean
  onToggleInbox: () => void
  /** Chat panel terbuka? Opsional supaya pemakaian Dock lama (dan test-nya) tetap valid:
   *  itemnya hanya dirender ketika integrator menyediakan handler. */
  chatOpen?: boolean
  onToggleChat?: () => void
  /** Item yang menunggu operator. 0 = tidak ada badge. Angkanya datang dari `useInboxBadge`;
   *  dock tidak pernah memanggil `fetch` sendiri. */
  inboxUnread?: number
  zoomPct: number; onZoomIn: () => void; onZoomOut: () => void
  /** Zoom ke persen absolut. Tanpa ini readout zoom cuma teks, bukan menu preset. */
  onZoomTo?: (pct: number) => void
  /** Kunci PANDANGAN (pan/zoom) sementara node tetap bisa digeser — semantik nodeterm, kebalikan
   *  dari `showInteractive` bawaan React Flow yang justru mematikan drag node. Tombolnya butuh
   *  `aria-pressed`, jadi ia dirender sendiri di bawah activity bar, bukan sebagai item primitif. */
  locked: boolean
  onToggleLock: () => void
  /** Clean view menyala? Jalan keluarnya chord ⌘./Ctrl+. karena chrome ini sendiri ikut
   *  tersembunyi (lihat `cleanView.tsx`). */
  cleanView: boolean
  onToggleCleanView: () => void
  /** Nama workspace aktif untuk status bar; kosong di layar Welcome. */
  workspaceName?: string
  /** Ringkasan agent (`2 working`) — juga diumumkan lewat live region status bar. */
  agentSummary?: string
  onSave?: () => void
  onLayouts?: () => void
  onToggleMic?: () => void
  /** Dari settings; tombolnya hilang dari menu Add. Prop, bukan store — integrator yang menyambung. */
  disabledAgents?: AgentId[]
  customAgents?: CustomAgent[]
  /** Override perintah peluncuran per builtin (mis. skrip pemilih akun). Hanya builtin: agent
   *  custom sudah membawa `launchCmd`-nya sendiri. */
  agentLaunchCommands?: Partial<Record<BuiltinAgentId, string>>
  /** Membuka dialog Settings. Tombolnya (di bawah Add node) hanya ada bila handler diberikan; ia
   *  membuka dialog modal, jadi tidak pernah ditandai aktif oleh `activeActivityId`. */
  onOpenSettings?: () => void
}

/** Preset zoom status bar, disalin dari nodeterm `src/renderer/lib/zoomPresets.ts`. */
export const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const

/** Glyph codicon (font ikon VS Code, dimuat di `main.tsx`); ukurannya diatur CSS per wadah. */
const codicon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden />

/** Id aktivitas yang sedang "terpilih". Activity bar hanya punya satu slot aktif; permukaan
 *  webterm boleh terbuka bersamaan, jadi urutannya dipaku dan sisanya tampil non-aktif. */
function activeActivityId(props: DockProps): string | null {
  if (props.sessionsOpen) return 'sessions'
  if (props.inboxOpen) return 'inbox'
  if (props.chatOpen) return 'chat'
  if (props.boardOpen) return 'board'
  return null
}

/**
 * Status bar 22px: aksi kanvas (undo/redo/back/forward/fit/zoom) plus identitas workspace.
 * Readout zoom di sini membuka dialog preset — dialognya milik komponen ini supaya Dock tidak
 * perlu merender dua baris grid sekaligus.
 */
function CanvasStatusBar(props: DockProps) {
  const [zoomOpen, setZoomOpen] = useState(false)

  const left: VscodeStatusItem[] = []
  if (props.workspaceName) {
    left.push({ id: 'workspace', label: props.workspaceName, tooltip: 'Active workspace' })
  }

  const right: VscodeStatusItem[] = [
    {
      id: 'undo', label: '', icon: codicon('discard'), tooltip: 'Undo', ariaLabel: 'Undo',
      onClick: props.canUndo ? props.onUndo : undefined,
    },
    {
      id: 'redo', label: '', icon: codicon('redo'), tooltip: 'Redo', ariaLabel: 'Redo',
      onClick: props.canRedo ? props.onRedo : undefined,
    },
    {
      id: 'back', label: '', icon: codicon('arrow-left'), tooltip: 'Go back', ariaLabel: 'Go back',
      onClick: props.canBack ? props.onBack : undefined,
    },
    {
      id: 'forward', label: '', icon: codicon('arrow-right'), tooltip: 'Go forward', ariaLabel: 'Go forward',
      onClick: props.canForward ? props.onForward : undefined,
    },
    ...(props.onSave ? [{
      id: 'save', label: '', icon: codicon('save'), tooltip: 'Save layout', ariaLabel: 'Save layout',
      onClick: props.onSave,
    }] : []),
    ...(props.onLayouts ? [{
      id: 'layouts', label: '', icon: codicon('layout'), tooltip: 'Layouts', ariaLabel: 'Layouts',
      onClick: props.onLayouts,
    }] : []),
    ...(props.onToggleMic ? [{
      id: 'mic', label: '', icon: codicon('mic'), tooltip: 'Dictate', ariaLabel: 'Dictate',
      onClick: props.onToggleMic,
    }] : []),
    {
      id: 'fit', label: '', icon: codicon('screen-normal'), tooltip: 'Fit view', ariaLabel: 'Fit view',
      onClick: props.onFit,
    },
    {
      id: 'zoom-out', label: '', icon: codicon('zoom-out'), tooltip: 'Zoom out', ariaLabel: 'Zoom out',
      onClick: props.onZoomOut,
    },
    {
      id: 'zoom', label: `${props.zoomPct}%`, tooltip: 'Zoom presets', ariaLabel: 'Zoom presets',
      onClick: props.onZoomTo ? () => setZoomOpen(true) : undefined,
    },
    {
      id: 'zoom-in', label: '', icon: codicon('zoom-in'), tooltip: 'Zoom in', ariaLabel: 'Zoom in',
      onClick: props.onZoomIn,
    },
  ]

  return (
    <>
      <VscodeStatusBar
        className="app-statusbar"
        left={left}
        right={right}
        liveText={props.agentSummary}
      />
      {zoomOpen && (
        <Dialog open onOpenChange={setZoomOpen}>
          <DialogContent className="dock-zoom-dialog">
            <DialogHeader><DialogTitle>Zoom</DialogTitle></DialogHeader>
            <div className="dock-zoom-list">
              {ZOOM_PRESETS.map((p) => (
                <Button
                  key={p}
                  variant={p === props.zoomPct ? 'secondary' : 'ghost'}
                  className="dock-action-row"
                  onClick={() => { props.onZoomTo?.(p); setZoomOpen(false) }}
                >
                  <span className="dock-menu__check">{p === props.zoomPct && codicon('check')}</span>{p}%
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/**
 * Chrome kiri + bawah aplikasi.
 *
 * Activity bar 48px memuat permukaan (Sessions, Inbox, Chat, Board) dan aksi Add; lock/clean view
 * adalah toggle mode sehingga dirender sendiri dengan `aria-pressed`. Status bar 22px memuat
 * aksi kanvas. Dialog Add/Workspace tetap di sini karena tombol pembukanya ada di rail.
 */
export default function Dock(props: DockProps) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsCwd, setWsCwd] = useState('')

  const disabled = props.disabledAgents ?? DEFAULT_SETTINGS.disabledAgents
  const customs = props.customAgents ?? DEFAULT_SETTINGS.customAgents
  const launchCmds = props.agentLaunchCommands ?? DEFAULT_SETTINGS.agentLaunchCommands
  const builtins = BUILTIN_AGENT_IDS.filter((a) => !disabled.includes(a))
  const visibleCustoms = customs.filter((c) => !disabled.includes(c.id))

  useEffect(() => {
    if (!addOpen && !workspaceOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAddOpen(false)
      setWorkspaceOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addOpen, workspaceOpen])

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

  const items: VscodeActivityBarItem[] = [
    { id: 'sessions', label: 'Toggle sessions panel', icon: codicon('layout-sidebar-left') },
    {
      id: 'inbox', label: 'Toggle inbox panel', icon: codicon('inbox'),
      badge: props.inboxUnread,
    },
    ...(props.onToggleChat
      ? [{ id: 'chat', label: 'Toggle chat panel', icon: codicon('comment-discussion') }]
      : []),
    { id: 'board', label: 'Board', icon: codicon('project') },
    { id: 'add', label: 'Add node', icon: codicon('add') },
    ...(props.onOpenSettings
      ? [{ id: 'settings', label: 'Settings', icon: codicon('settings-gear') }]
      : []),
  ]

  const onActivitySelect = (id: string) => {
    switch (id) {
      case 'sessions':
        props.onToggleSessions()
        break
      case 'inbox':
        props.onToggleInbox()
        break
      case 'chat':
        props.onToggleChat?.()
        break
      case 'board':
        props.onToggleBoard()
        break
      case 'add':
        setAddOpen(true)
        break
      case 'settings':
        props.onOpenSettings?.()
        break
      default:
        break
    }
  }

  return (
    <>
      <div className="dock">
        <VscodeActivityBar
          items={items}
          activeId={activeActivityId(props)}
          onSelect={onActivitySelect}
          ariaLabel="Activity bar"
        />

        {/* Dua toggle MODE: lock pandangan dan clean view. Keduanya butuh `aria-pressed`, yang
            tidak dimiliki item navigasi activity bar. */}
        <div className="dock__modes" data-slot="dock-modes">
          <button
            type="button"
            className="vscode-activity-bar__item dock-btn"
            aria-label={props.locked ? 'Unlock view' : 'Lock view'}
            title={props.locked ? 'Unlock view (pan/zoom)' : 'Lock view (pan/zoom); nodes stay movable'}
            aria-pressed={props.locked}
            onClick={props.onToggleLock}
          >
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon(props.locked ? 'lock' : 'unlock')}</span>
          </button>

          <button
            type="button"
            className="vscode-activity-bar__item dock-btn"
            aria-label="Clean view"
            title="Clean view — hide all chrome (⌘./Ctrl+. to exit)"
            aria-pressed={props.cleanView}
            onClick={props.onToggleCleanView}
          >
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon('eye-closed')}</span>
          </button>
        </div>

        {addOpen && (
          <Dialog open onOpenChange={setAddOpen}>
            <DialogContent className="dock-add-dialog">
              <DialogHeader><DialogTitle>Add node</DialogTitle></DialogHeader>
              <div className="dock-add-list">
                <Button variant="ghost" className="dock-action-row" onClick={addTerminal}>{codicon('terminal')} Terminal</Button>
                {builtins.map((a) => {
                  const cfg = agentConfig(a)
                  return <Button key={a} variant="ghost" className="dock-action-row" title={cfg?.notice} onClick={() => addBuiltin(a)}><span className="dock-menu__glyph bg-[var(--agent-color)]" style={{ '--agent-color': cfg?.color ?? FALLBACK_AGENT_COLOR } as CSSProperties} />{cfg?.label ?? a}</Button>
                })}
                {visibleCustoms.map((c) => <Button key={c.id} variant="ghost" className="dock-action-row" onClick={() => addCustom(c)}><span className="dock-menu__glyph bg-[var(--agent-color)]" style={{ '--agent-color': c.color ?? FALLBACK_AGENT_COLOR } as CSSProperties} />{c.label}</Button>)}
                <Button variant="ghost" className="dock-action-row" onClick={openWorkspaceForm}>{codicon('new-folder')} Workspace…</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {workspaceOpen && (
          <Dialog open onOpenChange={setWorkspaceOpen}>
            <DialogContent>
              <DialogHeader><DialogTitle>Create workspace</DialogTitle></DialogHeader>
              <div className="dock-menu__form">
                <Input placeholder="name" autoFocus value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createWs() }} />
                <div className="dock-menu__form-row">
                  <Input className="flex-1" placeholder="cwd (optional)" value={wsCwd}
                    onChange={(e) => setWsCwd(e.target.value)} />
                  <Button variant="ghost" onClick={() => props.onBrowse(setWsCwd)}>Browse</Button>
                </div>
                <Button onClick={createWs}>Create</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <CanvasStatusBar {...props} />
    </>
  )
}
