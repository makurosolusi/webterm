import { useEffect, useRef, useState } from 'react'
import type { NodeProps, Viewport } from '@xyflow/react'
import { Handle, Position, NodeResizer, useReactFlow } from '@xyflow/react'
import { agentConfig, canResume, hasUsage, isContextCapable, mintsSessionId } from '../shared/workspace'
import type { AgentId, AgentStatus, Comment } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome, { termNodeClass } from './NodeChrome'
import UsagePill from './UsagePill'
import FindBar from './FindBar'
import { useSpeechInput } from './useSpeechInput'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import { EXIT_SETTLE_MS, ineligibleHint, restartEligibility, sendExitSequence } from './agentActions'
import { send, subscribeStatus, getStatus } from './ws'
import { generateName as apiGenerateName } from './api'

const COLLAPSED_H = 40

export default function AgentNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    cmd?: string; cwd?: string; agentId?: AgentId; color?: string; title?: string
    sessionId?: string; collapsed?: boolean; comments?: Comment[]; agentModel?: string
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

  const builtin = agentId ? agentConfig(agentId) : undefined
  const swatch = d.color ?? builtin?.color ?? '#0a84ff'
  const label = d.title ?? builtin?.label ?? agentId ?? 'agent'
  const collapsed = d.collapsed ?? false
  const comments = d.comments ?? []
  // Pill TIDAK pernah menerima judul node: ia dirender persis di sebelah judul, jadi mengirim judul
  // membuatnya menduplikasi tetangganya dan tidak mengatakan apa pun. Ia butuh MODEL, dan hanya
  // untuk agent yang punya meter konteks. Tanpa model yang dilaporkan, tidak ada pill.
  const usageModel = agentId && hasUsage(agentId) ? d.agentModel : undefined

  const [searchOpen, setSearchOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [aiNaming, setAiNaming] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [restarting, setRestarting] = useState(false)

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)
  const savedVp = useRef<Viewport | null>(null)
  const { micActive, toggleMic } = useSpeechInput((text) => send({ t: 'input', id, data: text }))

  // Hanya id yang KITA cetak saat peluncuran yang benar-benar bisa di-resume. Untuk agent lain
  // `sid` cuma uuid lokal yang tak pernah dilihat CLI-nya, jadi me-resume-nya akan membuka chat
  // kosong alih-alih percakapan yang sama.
  const resumableSid = agentId && mintsSessionId(agentId) ? sid : undefined

  // Sesi BARU: membunuh PTY dan mencetak uuid baru. Bukan restart — riwayatnya tidak terbawa, dan
  // claude menolak memakai ulang `--session-id` yang sudah ada.
  const newSession = () => {
    send({ t: 'close', id })
    const n = crypto.randomUUID()
    setSid(n); setResume(false); onSession?.(id, n); setGen((g) => g + 1)
  }
  // Resume menyambung kembali percakapan sebelumnya lewat uuid yang SAMA + `--resume`.
  const doResume = () => { setResume(true); setGen((g) => g + 1) }

  /**
   * Restart in-place: minta CLI keluar baik-baik (urutan tombolnya sendiri), lalu luncurkan ulang
   * dengan `--resume` sehingga percakapannya kembali. Keluar baik-baik itu intinya — ia yang
   * membuat transcript ditulis tuntas ke disk, yang kemudian dibaca `--resume`.
   *
   * CATATAN BEDA DARI NODETERM: nodeterm mengetikkan baris resume ke shell pane tmux yang SAMA.
   * webterm meluncurkan agent sebagai `shell -l -c "<cmd>"`, jadi keluarnya CLI mengakhiri shell
   * dan PTY-nya — tidak ada shell yang tersisa untuk diketiki. Jadi fase relaunch di sini adalah
   * spawn baru dengan `--resume`, setara dengan "Restart agent and shell" nodeterm.
   */
  const restartAgent = async () => {
    if (restarting) return // satu restart per node: dua urutan exit akan saling tumpang tindih
    setRestarting(true)
    try {
      await sendExitSequence(agentId, (data) => send({ t: 'input', id, data }))
      await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS))
      // No-op kalau CLI sudah keluar (server melupakan sesinya); jaring pengaman kalau belum.
      send({ t: 'close', id })
      setResume(true); setGen((g) => g + 1)
    } catch (e) {
      // ponytail: dilaporkan ke console, bukan toast — webterm belum punya permukaan notifikasi.
      // Upgrade: tampilkan lewat toast begitu ada. Node id saja, tanpa env/token.
      console.error(`restart agent node ${id}:`, e)
    } finally {
      setRestarting(false)
    }
  }

  const restartGate = restartEligibility(agentId, status, resumableSid)
  const canResumeNode = !!agentId && canResume(agentId) && !!resumableSid && status === 'done'
  const menuRows: MenuRow[] = [
    {
      label: 'Restart agent',
      disabled: !restartGate.ok || restarting,
      hint: restartGate.ok
        ? 'Meminta CLI keluar lalu meluncurkannya ulang dengan --resume (percakapan yang sama).'
        : ineligibleHint(restartGate.reason),
      onClick: () => { void restartAgent() },
    },
    {
      label: 'Resume session',
      disabled: !canResumeNode || restarting,
      hint: canResumeNode
        ? 'Menyambung kembali percakapan sebelumnya di PTY baru.'
        : 'Hanya untuk sesi yang sudah berakhir dan punya id yang bisa di-resume.',
      onClick: doResume,
    },
    { type: 'separator' },
    {
      label: 'New session',
      danger: true,
      hint: 'Membuang percakapan ini dan memulai sesi baru dengan id baru.',
      onClick: newSession,
    },
  ]

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

  const aiName = async () => {
    setAiNaming(true)
    // ponytail: on !r.ok the title is left unchanged (no error surface) — webterm has no
    // toast yet. Upgrade: surface message via toast when a notification surface exists.
    try { const r = await apiGenerateName(id); if (r.ok) rf.updateNodeData(id, { title: r.message }) }
    finally { setAiNaming(false) }
  }

  // onBroadcast stays via `ext` (undefined → hidden): webterm deliberately has no live-link,
  // mirroring nodeterm Server Edition where loopback single-user has no viewer/relay — a
  // faithful mirror, not a TODO. onAiName is now local (above).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passthrough of not-yet-wired handlers
  const ext = data as any

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed, status })}
        style={{ borderTopColor: swatch }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <NodeChrome
          title={label}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          status={status}
          pill={usageModel ? <UsagePill modelLabel={usageModel} /> : undefined}
          comments={comments} onAddComment={addComment}
          onRefresh={() => termRef.current?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={toggleMic}
          maximized={maximized} onToggleMaximize={toggleMaximize}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
          onAiName={aiName} aiNaming={aiNaming}
          onBroadcast={ext.onBroadcast} broadcastActive={ext.broadcastActive} broadcastDisabled={ext.broadcastDisabled}
          hideLinks={ext.hideLinks} onToggleHideLinks={ext.onToggleHideLinks}
        />
        <div className="node-body">
          <TerminalCore
            key={gen}
            ref={termRef}
            id={id}
            cmd={cmd}
            cwd={cwd}
            agentId={agentId}
            sessionId={resumableSid}
            resume={resume}
          />
        </div>
        {searchOpen && (
          <FindBar
            onSearch={(t, dir) => termRef.current?.search(t, { direction: dir })}
            onClose={() => { setSearchOpen(false); termRef.current?.clearSearch() }}
          />
        )}
        {/* copilot sengaja TIDAK context-capable (ia tak memindai ~/.claude/skills), jadi
            `isContextCapable` yang memutuskan — bukan "ini node agent" — supaya ia tidak dapat
            handle yang hanya menghasilkan edge mati. */}
        {isContextCapable(agentId) && (<>
          <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
          <Handle id="link-in"  type="target" position={Position.Left}  className="bridge-handle" />
        </>)}
      </div>
      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menuRows} onClose={() => setMenu(null)} />}
    </>
  )
}
