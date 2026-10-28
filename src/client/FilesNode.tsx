// Node file-manager. Diport dari nodeterm `src/renderer/nodes/FilesNode.tsx`; SEMUA keputusannya
// (naik ke mana, breadcrumb apa, filter cocok apa, tombol melakukan apa) ada di `./fileBrowse.ts`
// supaya bisa dites tanpa DOM — vitest webterm berjalan di node-env.
//
// TANPA FILE WATCHER, sama seperti nodeterm: refresh `⟳` manual menaikkan `version`. Watcher berarti
// satu `fs.watch` per node yang terbuka plus debounce plus rekonsiliasi seleksi, demi sesuatu yang
// jarang berubah di belakang punggung pengguna.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Node, NodeProps } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { ChevronRight, ClipboardCopy, File, FilePlus, Folder, FolderPlus, TerminalSquare } from 'lucide-react'
import type { Comment } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import * as fsClient from './fsClient'
import {
  ancestorDirs,
  breadcrumbs,
  childOnPath,
  childPath,
  classifyEmptyListing,
  createTargetDir,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  newEntryPath,
  parentDir,
  type DirEntry,
  type EmptyListingVerdict,
} from './fileBrowse'
import { EDITOR_SIZE, planFileOpen } from './fileOpen'
import { listKeyAction, scrollTopToReveal, typeAhead } from './filesKeys'
import './files.css'

const COLLAPSED_H = 40
const UNREACHABLE = 'Could not reach this folder. It may be gone, or its filesystem may be unavailable.'

type Menu = { x: number; y: number; entry: DirEntry | null }

export default function FilesNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    dirPath?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[]
  }
  const rf = useReactFlow()
  const listRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ buffer: '', at: 0 })
  /** Nama yang harus terpilih begitu listing berikutnya mendarat — dipakai saat naik, supaya
   *  folder yang baru ditinggalkan yang terpilih (Explorer/Finder). */
  const pendingSel = useRef<string | null>(null)

  const cwd = d.dirPath ?? '/'
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []

  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [verdict, setVerdict] = useState<EmptyListingVerdict | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(-1)
  const [version, setVersion] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [notice, setNotice] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const expandedH = useRef(height ?? 300)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      const got = await fsClient.list(cwd)
      if (!alive) return
      setEntries(got)
      if (got.length > 0) setVerdict(null)
      else {
        // Listing kosong ambigu secara kontrak (lihat `classifyEmptyListing`): tanya INDUK.
        const parent = parentDir(cwd)
        const pe = parent === cwd ? null : await fsClient.list(parent)
        if (!alive) return
        setVerdict(classifyEmptyListing(cwd, pe))
      }
      setLoading(false)
      const want = pendingSel.current
      pendingSel.current = null
      setSel(want === null ? -1 : got.findIndex((e) => e.name === want))
    })()
    return () => { alive = false }
  }, [cwd, version])

  // Filter adalah pertanyaan tentang SATU direktori; membawanya ke direktori berikutnya membuat
  // folder tampak kosong karena kotak yang sudah tidak dilihat pengguna.
  useEffect(() => { setQuery(''); setNotice('') }, [cwd])

  const shown = filterEntries(entries, query)

  const navigate = useCallback((to: string, cameFrom?: string) => {
    if (cameFrom) pendingSel.current = childOnPath(to, cameFrom)
    // Judul mengikuti folder hanya selama pengguna belum menamainya sendiri.
    const auto = !d.title || d.title === folderTitle(cwd)
    rf.updateNodeData(id, { dirPath: to, ...(auto ? { title: folderTitle(to) } : {}) })
  }, [cwd, d.title, id, rf])

  const addNodeBeside = (
    nid: string, kind: 'terminal' | 'editor', extra: Record<string, unknown>, attrs?: Partial<Node>,
  ) => {
    const me = rf.getNode(id)
    rf.addNodes({
      id: nid, type: kind,
      position: { x: (me?.position.x ?? 0) + (me?.measured?.width ?? 420) + 32, y: me?.position.y ?? 0 },
      ...attrs,
      data: { id: nid, kind, color: swatch, ...extra },
    })
  }

  const open = (e: DirEntry) => {
    const p = childPath(cwd, e.name)
    if (e.dir) { navigate(p); return }
    // Tab browser tidak bisa menyerahkan file ke OS mesin server — katakan, jangan buka buffer sampah.
    if (fileOpenTarget(p) !== 'canvas') { setNotice(`${e.name} needs an application on the server to open.`); return }
    const plan = planFileOpen(rf.getNodes(), rf.getEdges(), id, p, crypto.randomUUID())
    if (plan.focus) rf.updateNode(plan.nodeId, { selected: true })
    else addNodeBeside(plan.nodeId, 'editor', { filePath: p, title: e.name }, { ...EDITOR_SIZE, selected: true })
    // Kabel penanda "file ini sedang terbuka". Dibuat langsung, BUKAN lewat `onConnect`: `canLink`
    // hanya meloloskan pasangan agent context-capable.
    if (plan.edge) rf.addEdges({ ...plan.edge, type: 'context' })
  }

  const createEntry = async (dir: boolean) => {
    // Buat DI DALAM folder yang diklik, tapi DI SAMPING file yang diklik.
    const base = menu?.entry ? createTargetDir(childPath(cwd, menu.entry.name), menu.entry.dir) : cwd
    const name = window.prompt(dir ? 'New folder name' : 'New file name')
    if (name === null) return
    const target = newEntryPath(base, name)
    if (!target) { setNotice('That name is not allowed here.'); return }
    for (const p of ancestorDirs(base, name)) await fsClient.mkdir(p)
    const ok = dir ? await fsClient.mkdir(target) : await fsClient.write(target, '')
    if (!ok) { setNotice(`Could not create ${name}.`); return }
    pendingSel.current = name.split('/')[0]
    setVersion((v) => v + 1)
  }

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  /** Gulirkan baris terpilih ke dalam pandangan. `scrollIntoView` juga menggulirkan ancestor yang
   *  bisa di-scroll — di dalam canvas itu menyeret seluruh pane React Flow. */
  const reveal = (idx: number) => {
    const box = listRef.current
    const row = box?.children[idx] as HTMLElement | undefined
    if (!box || !row) return
    box.scrollTop = scrollTopToReveal(row.offsetTop, row.offsetHeight, box.scrollTop, box.clientHeight)
  }

  const onListKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    // Canvas React Flow membajak keyboard: panah mem-pan, dan BACKSPACE MENGHAPUS NODE INI. Setiap
    // tombol yang kita tangani harus diklaim di sini, bukan hanya di-preventDefault.
    const claim = () => { ev.preventDefault(); ev.stopPropagation() }
    const act = listKeyAction({ key: ev.key, alt: ev.altKey, meta: ev.metaKey, ctrl: ev.ctrlKey }, sel, shown.length)
    if (act) {
      claim()
      if (act.kind === 'up') navigate(parentDir(cwd), cwd)
      else if (act.kind === 'open') open(shown[act.index])
      else { setSel(act.index); reveal(act.index) }
      return
    }
    if (ev.key === 'Escape' && query) { claim(); setQuery(''); return }
    if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      claim()
      const next = typeAhead(typed.current, ev.key, Date.now(), shown.map((e) => e.name), sel)
      typed.current = next.state
      if (next.index >= 0) { setSel(next.index); reveal(next.index) }
    }
  }

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const menuTarget = menu?.entry ? childPath(cwd, menu.entry.name) : cwd
  const crumbs = breadcrumbs(cwd)

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div className={termNodeClass({ selected: !!selected, collapsed })} style={{ borderTopColor: swatch }}>
        <NodeChrome
          title={d.title ?? ''}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          onAddComment={(text) =>
            rf.updateNodeData(id, { comments: [...comments, { id: crypto.randomUUID(), text, ts: Date.now() }] })}
          onRefresh={() => setVersion((v) => v + 1)}
          searchOpen={filterOpen} onToggleSearch={() => setFilterOpen((o) => !o)}
          maximized={maximized}
          onToggleMaximize={() => { rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized((m) => !m) }}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />

        <div className="node-body files-node">
          <div className="files-crumbs nodrag">
            {crumbs.map((c, i) => (
              <span key={`${c.path}:${i}`} className="files-crumb-wrap">
                {i > 0 && <ChevronRight size={11} className="files-crumb-sep" />}
                <button className="files-crumb" onClick={() => navigate(c.path, cwd)} title={c.path}>{c.name}</button>
              </span>
            ))}
          </div>

          {filterOpen && (
            <input
              className="files-filter nodrag field" autoFocus value={query} placeholder="Filter…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setFilterOpen(false) }}
            />
          )}

          <div ref={listRef} className="files-list nodrag nowheel" tabIndex={0} onKeyDown={onListKeyDown}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null }) }}
          >
            {shown.map((e, i) => (
              <div
                key={e.name}
                className={`files-row${i === sel ? ' files-row--sel' : ''}${e.ignored ? ' files-row--ignored' : ''}`}
                onClick={() => setSel(i)}
                onDoubleClick={() => open(e)}
                onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSel(i); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }}
              >
                {e.dir ? <Folder size={13} className="files-icon files-icon--dir" /> : <File size={13} className="files-icon" />}
                <span className="files-name">{e.name}</span>
              </div>
            ))}

            {/* Empat keadaan berbeda, sengaja TIDAK digabung: masing-masing menyuruh pengguna
                melakukan hal yang berbeda. */}
            {loading && <div className="files-empty">Loading…</div>}
            {!loading && entries.length === 0 && verdict === 'missing' && (
              <div className="files-empty files-empty--error">This folder no longer exists.</div>
            )}
            {!loading && entries.length === 0 && verdict === 'unreachable' && (
              <div className="files-empty files-empty--error">{UNREACHABLE}</div>
            )}
            {!loading && entries.length === 0 && (verdict === 'empty' || verdict === 'unknown') && (
              <div className="files-empty">This folder is empty.</div>
            )}
            {!loading && entries.length > 0 && shown.length === 0 && (
              <div className="files-empty">Nothing matches “{query.trim()}”.</div>
            )}
          </div>

          <div className="files-foot">{notice || `${shown.length} of ${entries.length}`}</div>
        </div>
      </div>

      {menu && createPortal(
        // Portal ke body: `position: fixed` di dalam ancestor ber-transform (viewport React Flow)
        // terkurung di containing block-nya, jadi menu akan mendarat di tempat yang salah.
        <div className="files-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {(() => {
            const target = menu.entry
            if (!target) return null
            return (
              <button onClick={() => { setMenu(null); open(target) }}>
                {target.dir ? <Folder size={13} /> : <File size={13} />} Open
              </button>
            )
          })()}
          <button onClick={() => { setMenu(null); addNodeBeside(crypto.randomUUID(), 'terminal', { cwd: menu.entry?.dir ? menuTarget : cwd }) }}>
            <TerminalSquare size={13} /> New terminal here
          </button>
          <button onClick={() => { void createEntry(false); setMenu(null) }}><FilePlus size={13} /> New file…</button>
          <button onClick={() => { void createEntry(true); setMenu(null) }}><FolderPlus size={13} /> New folder…</button>
          <button onClick={() => {
            setMenu(null)
            // Clipboard API menolak di konteks tak aman / tanpa izin; katakan, jangan diam.
            navigator.clipboard?.writeText(menuTarget).catch(() => setNotice('Could not copy the path.'))
          }}><ClipboardCopy size={13} /> Copy path</button>
        </div>,
        document.body
      )}
    </>
  )
}
