import { memo, useRef, useState } from 'react'
import type { NodeProps, Viewport } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import TerminalCore from './TerminalCore'
import type { TerminalHandle } from './TerminalCore'
import NodeChrome, { termNodeClass } from './NodeChrome'
import FindBar from './FindBar'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import { useSpeechInput } from './useSpeechInput'
import { send } from './ws'
import type { Comment } from '../shared/workspace'

const COLLAPSED_H = 40

/** Alasan baris Paste mati. Clipboard API menuntut secure context, jadi webterm yang dibuka lewat
 *  alamat LAN `http://` tidak punya `navigator.clipboard` sama sekali — sama seperti tombol mic di
 *  bawah. Barisnya tetap HADIR tapi disabled dengan alasan ini: menghilangkannya membuat pengguna
 *  mencari fitur yang tak pernah ada, membiarkannya aktif membuatnya diam-diam gagal. */
const NO_CLIPBOARD_HINT = 'Paste butuh secure context: buka webterm lewat https atau localhost.'

function TerminalNode({ id, data, selected, height }: NodeProps) {
  const d = data as { cwd?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const termRef = useRef<TerminalHandle>(null)

  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []

  const [searchOpen, setSearchOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Tanpa `onError`: node terminal tidak punya thread aktivitas seperti node agent, jadi kegagalan
  // RUNTIME dikte belum punya permukaan di sini. Yang dijaga cuma kasus "tidak didukung" di bawah.
  const { micActive, toggleMic, supported: micSupported } = useSpeechInput((text) => send({ t: 'input', id, data: text }))

  // `undefined` MENYEMBUNYIKAN tombolnya (kontrak NodeToolbar: "omit button if undefined"). Web Speech
  // menuntut secure context, jadi webterm yang dibuka lewat alamat LAN `http://` tidak punya API-nya
  // sama sekali — tombolnya hadir tapi bisu, tak bisa dibedakan pengguna dari tombol yang rusak.
  const onToggleMicProp = micSupported ? toggleMic : undefined

  // ponytail: expanded height disimpan di ref lokal, bukan data — node yang disimpan dalam keadaan
  // collapsed lalu di-reload kehilangan tinggi kustomnya (fallback 300). Upgrade: simpan expandedHeight di data (B3).
  const expandedH = useRef(height ?? 300)
  const savedVp = useRef<Viewport | null>(null)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const addComment = (text: string) =>
    rf.updateNodeData(id, { comments: [...comments, { id: crypto.randomUUID(), text, ts: Date.now() }] })

  // Dibaca saat render, bukan di dalam handler: baris menunya harus sudah tahu kalau API-nya absen.
  const canPaste = typeof navigator.clipboard?.readText === 'function'

  const paste = () => {
    // Kegagalan di sini normal (izin ditolak, dokumen tak fokus) tapi tidak boleh ditelan: tanpa
    // jejak, paste yang tidak terjadi tak bisa dibedakan dari clipboard yang kosong.
    navigator.clipboard.readText().then(
      (text) => { if (text) send({ t: 'input', id, data: text }) },
      (err: unknown) => { console.warn(`terminal ${id}: clipboard read rejected`, err) },
    )
  }

  const menuRows: MenuRow[] = [
    {
      label: 'Paste',
      disabled: !canPaste,
      hint: canPaste ? 'Kirim isi clipboard ke shell, seperti mengetiknya.' : NO_CLIPBOARD_HINT,
      onClick: paste,
    },
    { type: 'separator' },
    {
      label: 'Clear',
      hint: 'Buang scrollback terminal ini. Shell-nya tidak tersentuh.',
      onClick: () => termRef.current?.clear(),
    },
  ]

  const toggleMaximize = () => {
    if (!maximized) { savedVp.current = rf.getViewport(); rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized(true) }
    else { if (savedVp.current) rf.setViewport(savedVp.current, { duration: 200 }); setMaximized(false) }
  }

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed })}
        style={{ borderTopColor: swatch }}
        // Tanpa ini Chrome memunculkan menu bawaannya untuk `<canvas>` — "Copy Image" di atas
        // terminal. React Flow tidak menolong: `Pane` hanya meneruskan contextmenu yang target-nya
        // pane itu sendiri, jadi klik kanan di atas node tidak pernah sampai ke menu canvas.
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <NodeChrome
          title={d.title ?? ''}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments} onAddComment={addComment}
          onRefresh={() => termRef.current?.refit()}
          searchOpen={searchOpen} onToggleSearch={() => setSearchOpen((o) => !o)}
          micActive={micActive} onToggleMic={onToggleMicProp}
          maximized={maximized} onToggleMaximize={toggleMaximize}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div className="node-body"><TerminalCore ref={termRef} id={id} cwd={d.cwd} /></div>
        {searchOpen && (
          <FindBar
            onSearch={(t, dir) => termRef.current?.search(t, { direction: dir })}
            onClose={() => { setSearchOpen(false); termRef.current?.clearSearch() }}
          />
        )}
      </div>
      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menuRows} onClose={() => setMenu(null)} />}
    </>
  )
}

export default memo(TerminalNode)
