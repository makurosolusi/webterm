import { memo, useEffect, useRef, useState } from 'react'
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
import { unwatchNode, watchNode } from './unread'
import { randomId } from './randomId'
import { useNodeActions } from './nodeActions'
import { generateName as apiGenerateName } from './api'

const COLLAPSED_H = 40

/** Penanda catatan yang ditulis MESIN di thread aktivitas node, supaya tidak tertukar dengan
 *  catatan pengguna sendiri (`NodeComments` merender `author` di baris meta). */
const NOTE_AUTHOR = 'webterm'

/**
 * Apakah peluncuran PERTAMA node ini harus `--resume`, bukan `--session-id`?
 *
 * Node yang DATANG sudah membawa `sessionId` adalah node yang pernah diluncurkan: id itu sudah
 * dilihat CLI-nya, dan `claude --session-id <id-yang-sudah-ada>` menolaknya ("Session ID … is
 * already in use.", lihat `withSessionId` di shared/workspace.ts). Itu persis jalur close →
 * "Recently closed" → reopen: snapshot node dipulihkan utuh sehingga `sessionId` ikut kembali,
 * tapi PTY-nya sudah mati sehingga `open` benar-benar meluncurkan ulang, bukan re-attach.
 *
 * Digerbangi `mintsSessionId` dengan alasan yang sama seperti `resumableSid`: untuk agent lain
 * `sessionId` cuma uuid lokal yang tak pernah dilihat CLI-nya, jadi me-resume-nya akan membuka chat
 * kosong alih-alih melanjutkan percakapan.
 */
export function resumesOnFirstLaunch(agentId: AgentId | undefined, sessionId: string | undefined): boolean {
  return !!sessionId && !!agentId && mintsSessionId(agentId)
}

function AgentNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    cmd?: string; cwd?: string; agentId?: AgentId; color?: string; title?: string
    sessionId?: string; collapsed?: boolean; comments?: Comment[]; agentModel?: string
    hideLinks?: boolean
  }
  const { cmd, cwd, agentId, sessionId } = d
  const { onSession, onToggleHideLinks } = useNodeActions()
  const rf = useReactFlow()
  const termRef = useRef<TerminalHandle>(null)

  const [status, setStatus] = useState<AgentStatus | undefined>(() => getStatus(id))
  useEffect(() => subscribeStatus((sid, s) => { if (sid === id) setStatus(s) }), [id])

  // Keadaan BACA, terpisah dari keadaan kerja: memilih node ini membacanya (tanda unread hilang)
  // DAN menjadikannya node yang ditonton, sehingga turn yang berakhir sementara kamu duduk di sini
  // tidak pernah ditandai. Hanya di AgentNode, bukan TerminalNode: status hook cuma pernah datang
  // untuk node agent, jadi shell biasa tak punya turn yang bisa ditandai belum-dibaca.
  useEffect(() => {
    if (!selected) return
    watchNode(id)
    return () => unwatchNode(id)
  }, [selected, id])

  // Pre-generated session UUID enables claude --session-id (and later --resume).
  const [sid, setSid] = useState<string>(sessionId ?? randomId())
  // DITURUNKAN dari props, tidak dipaku `false`: node yang datang sudah ber-`sessionId` pernah
  // diluncurkan, dan meluncurkannya ulang dengan `--session-id` yang sama ditolak CLI. Lihat
  // `resumesOnFirstLaunch`. Initializer lazy supaya ia dibaca sekali per mount — bukan tiap render,
  // di mana `onSession` di bawah sudah mengisi `sessionId` dan node BARU pun akan terbaca resume.
  const [resume, setResume] = useState(() => resumesOnFirstLaunch(agentId, sessionId))
  // Bumping the key remounts TerminalCore so it re-sends `open`.
  const [gen, setGen] = useState(0)

  // Persist a freshly generated id up to App exactly once.
  useEffect(() => { if (!sessionId) onSession(id, sid) }, [])

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

  // Dideklarasikan SEBELUM `useSpeechInput` di bawah, yang memakainya sebagai permukaan error.
  const addComment = (text: string, author?: string) =>
    rf.updateNodeData(id, {
      comments: [...comments, { id: randomId(), text, ts: Date.now(), ...(author ? { author } : {}) }],
    })

  // Kegagalan dikte DILAPORKAN ke thread aktivitas node (field `comments`), bukan ditelan: webterm
  // belum punya toast, dan thread itu satu-satunya kanal yang sudah terlihat di node ini — badge
  // hitungnya muncul persis di sebelah tombol mic yang baru diklik.
  const { micActive, toggleMic, supported: micSupported } = useSpeechInput(
    (text) => send({ t: 'input', id, data: text }),
    (message) => addComment(message, NOTE_AUTHOR),
  )

  // Hanya id yang KITA cetak saat peluncuran yang benar-benar bisa di-resume. Untuk agent lain
  // `sid` cuma uuid lokal yang tak pernah dilihat CLI-nya, jadi me-resume-nya akan membuka chat
  // kosong alih-alih percakapan yang sama.
  const resumableSid = agentId && mintsSessionId(agentId) ? sid : undefined

  // Sesi BARU: membunuh PTY dan mencetak uuid baru. Bukan restart — riwayatnya tidak terbawa, dan
  // claude menolak memakai ulang `--session-id` yang sudah ada.
  const newSession = () => {
    send({ t: 'close', id })
    const n = randomId()
    setSid(n); setResume(false); onSession(id, n); setGen((g) => g + 1)
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

  const toggleMaximize = () => {
    if (!maximized) { savedVp.current = rf.getViewport(); rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized(true) }
    else { if (savedVp.current) rf.setViewport(savedVp.current, { duration: 200 }); setMaximized(false) }
  }

  /**
   * Beri nama node lewat AI. Kegagalan HARUS terlihat: `r.message` membawa diagnosis nyata dari
   * server ("No terminal output to read yet.", "is the claude CLI on PATH?"), dan sebelumnya ia
   * dibuang sehingga judulnya dibiarkan apa adanya — dari sisi pengguna tombol ini "tidak
   * berfungsi". Permukaannya thread aktivitas node, bukan toast (webterm belum punya satu pun).
   */
  const aiName = async () => {
    setAiNaming(true)
    try {
      const r = await apiGenerateName(id)
      if (r.ok) rf.updateNodeData(id, { title: r.message })
      else addComment(r.message, NOTE_AUTHOR)
    } catch (e) {
      // Dilempar = tak terduga (fetch gagal / respons bukan JSON). Dilaporkan DUA kali dengan
      // sengaja: catatan untuk pengguna, console untuk stack-nya. Node id saja, tanpa env/token.
      console.error(`ai name node ${id}:`, e)
      addComment(`AI naming failed: ${String(e)}`, NOTE_AUTHOR)
    } finally {
      setAiNaming(false)
    }
  }

  // `undefined` MENYEMBUNYIKAN tombolnya (kontrak NodeToolbar: "omit button if undefined"), dan di
  // kedua kasus ini tombolnya tidak akan pernah bisa bekerja — tombol yang hadir tapi bisu tidak
  // bisa dibedakan pengguna dari tombol yang rusak, dan itu persis keluhannya.
  // - mic: browser/origin tanpa Web Speech (ia menuntut secure context).
  // - mata: node yang TIDAK context-capable tidak pernah dapat handle link (lihat `isContextCapable`
  //   di bawah), jadi ia tak punya edge untuk disembunyikan dan `hideLinks` tak mengubah apa pun.
  const onToggleMicProp = micSupported ? toggleMic : undefined
  const onToggleHideLinksProp = isContextCapable(agentId) ? () => onToggleHideLinks(id) : undefined

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
          micActive={micActive} onToggleMic={onToggleMicProp}
          maximized={maximized} onToggleMaximize={toggleMaximize}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
          onAiName={aiName} aiNaming={aiNaming}
          onBroadcast={ext.onBroadcast} broadcastActive={ext.broadcastActive} broadcastDisabled={ext.broadcastDisabled}
          hideLinks={d.hideLinks} onToggleHideLinks={onToggleHideLinksProp}
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

export default memo(AgentNode)
