import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { agentConfig, canResume, hasUsage, isContextCapable, mintsSessionId } from '../shared/workspace'
import type { AgentId, AgentStatus, Comment, Pane } from '../shared/workspace'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { withNodeName } from './nodeName.label'
import UsagePill from './UsagePill'
import FindBar from './FindBar'
import { useSpeechInput } from './useSpeechInput'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import { linkRows } from './terminalLinks'
import { PROVENANCE_TEXT, ProvenancePanel } from './ProvenancePanel'
import { MEMORY_TEXT, setNodeIncognito, useNodeIncognito } from './AgentMemory.api'
import { EXIT_SETTLE_MS, ineligibleHint, restartEligibility, sendExitSequence } from './agentActions'
import { send, subscribeStatus, getStatus } from './ws'
import { unwatchNode, watchNode } from './unread'
import { randomId } from './randomId'
import { useNodeActions } from './nodeActions'
import { generateName as apiGenerateName } from './api'
import { autoTitleFromWork, canResumeAfter, isAutoName, stopAgent, stopIdleAgents, uniqueTitle } from './nodeIdentity'
import { AgentEndedBar, AgentFailedBar } from './AgentFailedBar'
import { ClaudeTerminalViewToggle } from './agentChat/claudeViewSwitch'
import { AgentStatusChip } from './NodeStatusChip'
import { useNodeStatusFacts } from './nodeStatus.store'
import NodeStatusBar from './NodeStatusBar'

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
    cmd?: string; cwd?: string; agentId?: AgentId; color?: string; name?: string; title?: string
    sessionId?: string; collapsed?: boolean; comments?: Comment[]; agentModel?: string
    hideLinks?: boolean; claudeProfileId?: string; panes?: Pane
  }
  const { cmd, cwd, agentId, sessionId } = d
  const { onSession, onToggleHideLinks, openBrowserAt } = useNodeActions()
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
  // When the current launch was sent (per remount): output and exits older than this belong to the previous process.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on purpose for each launch generation
  const openedAt = useMemo(() => Date.now(), [gen])
  const facts = useNodeStatusFacts(id, true)
  // Ended normally: the hook said so, or (no hook) the server saw this launch's process exit.
  const ended = status === 'done' || status === 'stopped' || (!status && !!facts && !facts.live && !!facts.exit && facts.exit.at >= openedAt)

  // Persist a freshly generated id up to App exactly once.
  useEffect(() => { if (!sessionId) onSession(id, sid) }, [])

  // Identity: titles of the OTHER nodes are the uniqueness scope (one board = one React Flow).
  const boardTitles = () => rf.getNodes()
    .filter((n) => n.id !== id)
    .map((n) => (n.data as { title?: string }).title)
    .filter((t): t is string => !!t)
  const setTitle = (t: string) => rf.updateNodeData(id, { title: uniqueTitle(t, boardTitles()) })
  // First work (status → working) titles a still-untitled node from the task; one call in flight.
  const autoTitling = useRef(false)
  useEffect(() => {
    if (status !== 'working' || autoTitling.current) return
    autoTitling.current = true
    void autoTitleFromWork(id, {
      getTitle: () => (rf.getNode(id)?.data as { title?: string } | undefined)?.title,
      boardTitles,
      setTitle: (t) => rf.updateNodeData(id, { title: t }),
      generate: () => apiGenerateName(id),
    }).finally(() => { autoTitling.current = false })
  }, [status])

  const builtin = agentId ? agentConfig(agentId) : undefined
  const swatch = d.color ?? builtin?.color ?? '#0a84ff'
  // A legacy generated `<adjective>-<noun>` title counts as absent: the node name is the identity now.
  const label = (isAutoName(d.title) ? undefined : d.title) ?? builtin?.label ?? agentId ?? 'agent'
  const collapsed = d.collapsed ?? false
  const comments = d.comments ?? []
  // Pill TIDAK pernah menerima judul node: ia dirender persis di sebelah judul, jadi mengirim judul
  // membuatnya menduplikasi tetangganya dan tidak mengatakan apa pun. Ia butuh MODEL, dan hanya
  // untuk agent yang punya meter konteks. Tanpa model yang dilaporkan, tidak ada pill.
  const usageModel = agentId && hasUsage(agentId) ? d.agentModel : undefined

  const [searchOpen, setSearchOpen] = useState(false)
  const [aiNaming, setAiNaming] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; link: string | null } | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  const incognito = useNodeIncognito(id)

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)

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
   * CATATAN: webterm TIDAK mengetikkan baris resume ke shell pane yang sama.
   * webterm meluncurkan agent sebagai `shell -l -c "<cmd>"`, jadi keluarnya CLI mengakhiri shell
   * dan PTY-nya — tidak ada shell yang tersisa untuk diketiki. Jadi fase relaunch di sini adalah
   * spawn baru dengan `--resume`, setara dengan "Restart agent and shell".
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
  const canResumeNode = !!agentId && canResume(agentId) && !!resumableSid && canResumeAfter(status)
  const menuRows: MenuRow[] = [
    ...linkRows(menu?.link ?? null, id, openBrowserAt),
    {
      label: 'Restart agent',
      disabled: !restartGate.ok || restarting,
      hint: restartGate.ok
        ? 'Asks the CLI to exit, then relaunches it with --resume (same conversation).'
        : ineligibleHint(restartGate.reason),
      onClick: () => { void restartAgent() },
    },
    {
      label: 'Resume session',
      disabled: !canResumeNode || restarting,
      hint: canResumeNode
        ? 'Reconnects the previous conversation in a new PTY.'
        : 'Only for sessions that have ended and have a resumable id.',
      onClick: doResume,
    },
    { label: PROVENANCE_TEXT.menu, hint: PROVENANCE_TEXT.menuHint, onClick: () => setProvenanceOpen(true) },
    {
      // Same switch as Control › Memory (IncognitoToggle / setNodeIncognito); a menu row cannot host a
      // Switch, so the label flips. A failed switch is reported in the node thread, like AI naming.
      label: incognito ? MEMORY_TEXT.leaveIncognito : MEMORY_TEXT.goIncognito,
      hint: MEMORY_TEXT.incognitoIntro,
      onClick: () => { setNodeIncognito(id, !incognito).catch((e: unknown) => addComment(`Incognito switch failed: ${e instanceof Error ? e.message : String(e)}`, NOTE_AUTHOR)) },
    },
    { type: 'separator' },
    {
      label: 'New session',
      danger: true,
      hint: 'Discards this conversation and starts a new session with a new id.',
      onClick: newSession,
    },
  ]

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
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
      if (r.ok) setTitle(r.message)
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
  // as in a loopback single-user setup, where there is no viewer/relay — a
  // faithful mirror, not a TODO. onAiName is now local (above).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passthrough of not-yet-wired handlers
  const ext = data as any

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed, status })}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, link: termRef.current?.hoveredLink() ?? null }) }}
      >
        <NodeChrome
          title={label} name={d.name}
          icon="hubot"
          onRename={setTitle}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          statusChip={<AgentStatusChip id={id} status={status} openedAt={openedAt} />}
          pill={usageModel ? <UsagePill modelLabel={usageModel} /> : undefined}
          comments={comments} onAddComment={addComment}
          onRefresh={() => termRef.current?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={onToggleMicProp}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
          // VS Code shows Stop only while something runs: a working or blocked (mid-turn) agent.
          onStop={status === 'working' || status === 'blocked' ? () => { stopAgent(id, withNodeName(d.name, label), send) } : undefined}
          menuItems={[{
            type: 'item', id: 'stop-idle', label: 'Stop all idle agents on this board',
            onSelect: () => { stopIdleAgents(rf.getNodes(), getStatus, send) },
          }]}
          onAiName={aiName} aiNaming={aiNaming}
          onBroadcast={ext.onBroadcast} broadcastActive={ext.broadcastActive} broadcastDisabled={ext.broadcastDisabled}
          hideLinks={d.hideLinks} onToggleHideLinks={onToggleHideLinksProp}
          extraHeader={<ClaudeTerminalViewToggle nodeId={id} agentId={agentId} panes={d.panes} status={status} onStopTurn={() => send({ t: 'close', id })} />}
        />
        <div className="node-body node-body--stack relative">
          <div className="node-body__term">
            <TerminalCore
              key={gen}
              ref={termRef}
              id={id}
              cmd={cmd}
              cwd={cwd}
              agentId={agentId}
              sessionId={resumableSid}
              resume={resume}
              claudeProfileId={d.claudeProfileId}
            />
          </div>
          {/* A1/A2: Retry resumes the conversation when there is one, else launches it afresh. */}
          {status === 'failed' && <AgentFailedBar onRetry={() => { setResume(!!resumableSid); setGen((g) => g + 1) }} />}
          {status !== 'failed' && ended && (
            <AgentEndedBar onResume={agentId && canResume(agentId) && resumableSid ? doResume : undefined} onNewSession={newSession} />
          )}
        </div>
        {!collapsed && <NodeStatusBar sessionId={id} kind="agent" cwd={cwd} />}
        {searchOpen && (
          <FindBar
            onSearch={(t, dir) => termRef.current?.search(t, { direction: dir })}
            onClose={() => { setSearchOpen(false); termRef.current?.clearSearch() }}
          />
        )}
        {/* `isContextCapable` yang memutuskan — bukan "ini node agent" — supaya node CLI lain
            (mis. node warisan `codex`) tidak dapat handle yang hanya menghasilkan edge mati. */}
        {isContextCapable(agentId) && (<>
          <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
          <Handle id="link-in"  type="target" position={Position.Left}  className="bridge-handle" />
        </>)}
      </div>
      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menuRows} onClose={() => setMenu(null)} />}
      {provenanceOpen && <ProvenancePanel nodeId={id} onClose={() => setProvenanceOpen(false)} />}
    </>
  )
}

export default memo(AgentNode)
