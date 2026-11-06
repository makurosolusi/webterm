import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { useReactFlow } from '@xyflow/react'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome, { termNodeClass } from './NodeChrome'
import FindBar from './FindBar'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import PaneView from './PaneView'
import { closeLeaf, leafIds, nextPaneId, rootPane, setRatio, splitLeaf } from './paneTree'
import { useSpeechInput } from './useSpeechInput'
import { send } from './ws'
import { writeClipboard } from './clipboard'
import type { Comment, Pane } from '../shared/workspace'
import { randomId } from './randomId'
import { useNodeActions } from './nodeActions'
import { linkRows } from './terminalLinks'
import { isPathDrag, readDroppedPath } from './terminalDrop'

const COLLAPSED_H = 40

/** Alasan baris Paste mati. Clipboard API menuntut secure context, jadi webterm yang dibuka lewat
 *  alamat LAN `http://` tidak punya `navigator.clipboard` sama sekali — sama seperti tombol mic di
 *  bawah. Barisnya tetap HADIR tapi disabled dengan alasan ini: menghilangkannya membuat pengguna
 *  mencari fitur yang tak pernah ada, membiarkannya aktif membuatnya diam-diam gagal. */
const NO_CLIPBOARD_HINT = 'Paste needs a secure context: open webterm over https or localhost.'

function TerminalNode({ id, data, selected, height }: NodeProps) {
  const d = data as { cwd?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[]; panes?: Pane }
  const rf = useReactFlow()

  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []

  // Pohon pane EFEKTIF: node tanpa `panes` adalah satu daun ber-id node, jadi board lama tetap
  // memakai id sesi yang sama dan tidak kehilangan shell-nya.
  const panes = rootPane(id, d.panes)
  const [activePane, setActivePane] = useState(id)

  const [searchOpen, setSearchOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; pane: string; link: string | null } | null>(null)
  const { openBrowserAt } = useNodeActions()
  // Tanpa `onError`: node terminal tidak punya thread aktivitas seperti node agent, jadi kegagalan
  // RUNTIME dikte belum punya permukaan di sini. Yang dijaga cuma kasus "tidak didukung" di bawah.
  const { micActive, toggleMic, supported: micSupported } = useSpeechInput((text) => send({ t: 'input', id: activePane, data: text }))

  // `undefined` MENYEMBUNYIKAN tombolnya (kontrak NodeToolbar: "omit button if undefined"). Web Speech
  // menuntut secure context, jadi webterm yang dibuka lewat alamat LAN `http://` tidak punya API-nya
  // sama sekali — tombolnya hadir tapi bisu, tak bisa dibedakan pengguna dari tombol yang rusak.
  const onToggleMicProp = micSupported ? toggleMic : undefined

  // Satu handle per pane. Ref callback-nya memang dipasang ulang tiap render (identitasnya berubah),
  // jadi React melepas lalu memasang kembali dalam commit yang sama — map ini cuma dibaca dari
  // event handler, tidak pernah di tengah commit, jadi pergantian itu tak terlihat.
  const handles = useRef(new Map<string, TerminalHandle>())
  const setHandle = useCallback((paneId: string, h: TerminalHandle | null) => {
    if (h) handles.current.set(paneId, h)
    else handles.current.delete(paneId)
  }, [])
  /** Terminal yang jadi sasaran aksi header. Jatuh ke pane pertama yang ada: pane aktif bisa baru
   *  saja ditutup, dan tombol search yang diam-diam tidak melakukan apa pun lebih buruk. */
  const term = (): TerminalHandle | undefined =>
    handles.current.get(activePane) ?? handles.current.values().next().value

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const addComment = (text: string) =>
    rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })

  /** Pane baru lahir di sebelah (`h`) atau di bawah (`v`) `target`, dan langsung jadi pane aktif —
   *  seperti Ghostty/tmux, di mana split berikutnya membelah yang baru itu. */
  const split = (dir: 'h' | 'v', target: string) => {
    const paneId = nextPaneId(panes, id)
    const next = splitLeaf(panes, target, dir, paneId)
    if (next === panes) return // `target` bukan daun di pohon ini — tak ada yang terbelah
    rf.updateNodeData(id, { panes: next })
    setActivePane(paneId)
  }

  /** Tutup SATU pane: PTY-nya dimatikan lalu pohonnya dikempiskan. Daun terakhir berarti yang
   *  diminta sebenarnya menutup node, dan itu dirutekan ke `deleteElements` supaya riwayat
   *  "Recently closed" dan penutupan tiap sesi tetap lewat satu jalur (`onNodesChange` di App). */
  const closePane = (target: string) => {
    const next = closeLeaf(panes, target)
    if (!next) { void rf.deleteElements({ nodes: [{ id }] }); return }
    send({ t: 'close', id: target })
    rf.updateNodeData(id, { panes: next })
    if (target === activePane) setActivePane(leafIds(next)[0])
  }

  // Dibaca saat render, bukan di dalam handler: baris menunya harus sudah tahu kalau API-nya absen.
  const canPaste = typeof navigator.clipboard?.readText === 'function'

  const hasSelection = (target: string) => handles.current.get(target)?.hasSelection() ?? false

  const paste = (target: string) => {
    // Kegagalan di sini normal (izin ditolak, dokumen tak fokus) tapi tidak boleh ditelan: tanpa
    // jejak, paste yang tidak terjadi tak bisa dibedakan dari clipboard yang kosong.
    navigator.clipboard.readText().then(
      // `paste` lewat xterm, bukan `input` mentah: bracketed paste dan normalisasi newline ikut.
      (text) => { if (text) handles.current.get(target)?.paste(text) },
      (err: unknown) => { console.warn(`terminal ${target}: clipboard read rejected`, err) },
    )
  }

  /** Pane di bawah kursor drop (bukan pane aktif); jatuh ke pane aktif bila drop di luar pane. */
  const dropTarget = (el: EventTarget): string =>
    (el as HTMLElement).closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? activePane

  /** Baris menu untuk pane YANG DIKLIK, bukan untuk node: di node yang terbelah, "Close pane" yang
   *  mengenai pane lain dari yang ditunjuk pengguna membunuh terminal yang salah. */
  const menuRows = (target: string, link: string | null): MenuRow[] => [
    ...linkRows(link, id, openBrowserAt),
    {
      label: 'Copy',
      disabled: !hasSelection(target),
      hint: hasSelection(target) ? 'Copy the selected text to the clipboard.' : 'Select text in the terminal first.',
      onClick: () => {
        const text = handles.current.get(target)?.getSelection()
        if (text) void writeClipboard(text).then((ok) => { if (!ok) console.warn(`terminal ${target}: clipboard write failed`) })
      },
    },
    {
      label: 'Paste',
      disabled: !canPaste,
      hint: canPaste ? 'Send the clipboard contents to the shell, as if typed.' : NO_CLIPBOARD_HINT,
      onClick: () => paste(target),
    },
    { type: 'separator' },
    {
      label: 'Split right',
      hint: 'Split this pane into two side by side, each with its own shell.',
      onClick: () => split('h', target),
    },
    {
      label: 'Split down',
      hint: 'Split this pane into two stacked, each with its own shell.',
      onClick: () => split('v', target),
    },
    {
      label: 'Close pane',
      danger: true,
      hint: 'End this pane’s shell; other panes in this node are untouched.',
      onClick: () => closePane(target),
    },
    { type: 'separator' },
    {
      label: 'Clear',
      hint: 'Discard this terminal’s scrollback. The shell is untouched.',
      onClick: () => handles.current.get(target)?.clear(),
    },
  ]

  // Node yang baru dipilih / pane aktif yang berganti → keyboard langsung ke terminal itu.
  useEffect(() => {
    if (selected && !collapsed) term()?.focus()
  }, [selected, collapsed, activePane])


  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed })}
        // Tanpa ini Chrome memunculkan menu bawaannya untuk `<canvas>` — "Copy Image" di atas
        // terminal. React Flow tidak menolong: `Pane` hanya meneruskan contextmenu yang target-nya
        // pane itu sendiri, jadi klik kanan di atas node tidak pernah sampai ke menu canvas.
        // Drop path dari file manager → paste (tanpa newline) ke pane di bawah kursor. Input ke sesi
        // yang sudah exit dibuang oleh `send` di ws.ts, jadi paste ke sana tak mengeksekusi apa pun.
        onDragOver={(e) => {
          if (!isPathDrag(e.dataTransfer)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          const text = readDroppedPath(e.dataTransfer)
          if (!text) return
          e.preventDefault()
          e.stopPropagation()
          const target = dropTarget(e.target)
          setActivePane(target)
          handles.current.get(target)?.paste(text)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // Pane diambil dari TARGET, bukan dari pane aktif: urutan pointerdown/contextmenu berbeda
          // antar browser, jadi "yang aktif" belum tentu yang ada di bawah kursor.
          const host = (e.target as HTMLElement).closest('[data-pane-id]')
          const pane = host?.getAttribute('data-pane-id') ?? activePane
          // Link ditangkap SEKARANG: `leave` xterm terpicu begitu kursor pindah ke menu.
          setMenu({ x: e.clientX, y: e.clientY, pane, link: handles.current.get(pane)?.hoveredLink() ?? null })
        }}
      >
        <NodeChrome
          title={d.title ?? ''}
          icon="terminal" description={d.cwd}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments} onAddComment={addComment}
          onRefresh={() => term()?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={onToggleMicProp}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div className="node-body">
          <PaneView
            pane={panes}
            cwd={d.cwd}
            activeId={activePane}
            onActivate={setActivePane}
            onHandle={setHandle}
            onRatio={(path, ratio) => rf.updateNodeData(id, { panes: setRatio(panes, path, ratio) })}
          />
        </div>
        {searchOpen && (
          <FindBar
            onSearch={(t, dir) => term()?.search(t, { direction: dir })}
            onClose={() => { setSearchOpen(false); term()?.clearSearch() }}
          />
        )}
      </div>
      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menuRows(menu.pane, menu.link)} onClose={() => setMenu(null)} />}
    </>
  )
}

export default memo(TerminalNode)
