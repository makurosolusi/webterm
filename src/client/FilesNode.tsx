// Node file-manager. Diport dari nodeterm `src/renderer/nodes/FilesNode.tsx`; SEMUA keputusannya
// (naik ke mana, breadcrumb apa, filter cocok apa, tombol melakukan apa) ada di `./fileBrowse.ts`
// supaya bisa dites tanpa DOM — vitest webterm berjalan di node-env.
//
// TANPA FILE WATCHER, sama seperti nodeterm: refresh `⟳` manual menaikkan `version`. Watcher berarti
// satu `fs.watch` per node yang terbuka plus debounce plus rekonsiliasi seleksi, demi sesuatu yang
// jarang berubah di belakang punggung pengguna.
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { NodeResizer, useReactFlow } from '@xyflow/react'
import { Button as VscodeButton, Textfield, Tree, TreeItem } from '@/vscode/register'
import type { Comment } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import NodeContextMenu, { type MenuRow } from './NodeContextMenu'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
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
import { fileIconClass, folderIconClass } from './fileIcon'
import { EDITOR_SIZE, planFileOpen } from './fileOpen'
import { listKeyAction, scrollTopToReveal, typeAhead } from './filesKeys'
import { randomId } from './randomId'
import './files.css'

const COLLAPSED_H = 40
const UNREACHABLE = 'Could not reach this folder. It may be gone, or its filesystem may be unavailable.'

type Menu = { x: number; y: number; entry: DirEntry | null }

/** Ikon codicon dekoratif (CSS codicon dimuat shell). */
const codicon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

function FilesNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    dirPath?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[]
  }
  const rf = useReactFlow()
  const listRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement | null>(null)
  const filterRef = useRef<HTMLElement | null>(null)
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

  /** Indeks baris dari event yang mendarat di konten slotted sebuah `vscode-tree-item`.
   *  Klik di area kosong baris di-retarget ke host item (shadow DOM), jadi host ikut membawa
   *  `data-index` — kalau hanya span teks yang membawanya, separuh lebar baris jadi area mati. */
  const rowIndexFrom = (target: EventTarget | null): number => {
    const row = target instanceof Element
      ? target.closest('.files-row, vscode-tree-item[data-index]')
      : null
    const raw = row?.getAttribute('data-index')
    return raw === null || raw === undefined ? -1 : Number(raw)
  }

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
    const plan = planFileOpen(rf.getNodes(), rf.getEdges(), id, p, randomId())
    if (plan.focus) rf.updateNode(plan.nodeId, { selected: true })
    else addNodeBeside(plan.nodeId, 'editor', { filePath: p, title: e.name }, { ...EDITOR_SIZE, selected: true })
    // Kabel penanda "file ini sedang terbuka". Dibuat langsung, BUKAN lewat `onConnect`: `canLink`
    // hanya meloloskan pasangan agent context-capable.
    // `kind` WAJIB masuk ke `data`, bukan level atas: itu satu-satunya tempat yang dibaca
    // `decorateEdges` (label "↔ open") dan `toBridge` (persistensi). Di level atas React Flow
    // menyimpannya tanpa keluhan, lalu kabelnya tampil "⇄ context" dan tersimpan sebagai context.
    if (plan.edge) {
      const { kind: edgeKind, ...edge } = plan.edge
      rf.addEdges({ ...edge, type: 'context', data: { kind: edgeKind } })
    }
  }

  // Handler baris dipasang NATIVE di fase capture, bukan lewat prop React: klik di dalam
  // `vscode-tree-item` dihentikan oleh komponen itu di shadow DOM sebelum event sempat naik ke
  // root React, jadi `onClick`/`onDoubleClick` delegasi React tidak pernah melihatnya di browser.
  // Capture di list (di luar shadow) berjalan lebih dulu, dan target slotted tetap terbaca.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const hit = (event: Event) => {
      const index = rowIndexFrom(event.target)
      const entry = index >= 0 ? shown[index] : undefined
      return entry ? { index, entry } : null
    }
    const onClick = (event: MouseEvent) => {
      const row = hit(event)
      if (!row) return
      list.focus()
      setSel(row.index)
    }
    const onDoubleClick = (event: MouseEvent) => {
      const row = hit(event)
      if (!row) return
      setSel(row.index)
      open(row.entry)
    }
    const onContextMenu = (event: MouseEvent) => {
      const row = hit(event)
      if (!row) return
      event.preventDefault()
      event.stopPropagation()
      setSel(row.index)
      setMenu({ x: event.clientX, y: event.clientY, entry: row.entry })
    }
    list.addEventListener('click', onClick, true)
    list.addEventListener('dblclick', onDoubleClick, true)
    list.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      list.removeEventListener('click', onClick, true)
      list.removeEventListener('dblclick', onDoubleClick, true)
      list.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [shown])

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
    const row = treeRef.current?.children[idx] as HTMLElement | undefined
    if (!box || !row) return
    box.scrollTop = scrollTopToReveal(row.offsetTop, row.offsetHeight, box.scrollTop, box.clientHeight)
  }

  // `autofocus` hanya berlaku saat elemen pertama kali dipasang, sedangkan filter dibuka-tutup.
  // `delegatesFocus` di vscode-textfield meneruskan fokus host ke input di shadow DOM.
  useEffect(() => {
    if (filterOpen) filterRef.current?.focus()
  }, [filterOpen])

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

  const menuTarget = menu?.entry ? childPath(cwd, menu.entry.name) : cwd
  const crumbs = breadcrumbs(cwd)
  const menuRows: MenuRow[] = (() => {
    if (!menu) return []
    const target = menu.entry
    const rows: MenuRow[] = []
    if (target) {
      rows.push({
        label: 'Open',
        icon: codicon(target.dir ? 'folder' : 'file'),
        onClick: () => open(target),
      })
    }
    rows.push({
      label: 'Open in Integrated Terminal',
      icon: codicon('terminal'),
      onClick: () => addNodeBeside(randomId(), 'terminal', { cwd: target?.dir ? menuTarget : cwd }),
    })
    rows.push({ label: 'New File…', icon: codicon('new-file'), onClick: () => { void createEntry(false) } })
    rows.push({ label: 'New Folder…', icon: codicon('new-folder'), onClick: () => { void createEntry(true) } })
    rows.push({
      label: 'Copy Path',
      icon: codicon('copy'),
      onClick: () => {
        // Clipboard API menolak di konteks tak aman / tanpa izin; katakan, jangan diam.
        navigator.clipboard?.writeText(menuTarget).catch(() => setNotice('Could not copy the path.'))
      },
    })
    return rows
  })()

  return (
    <>
      <NodeResizer isVisible={!!selected && !collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed })}
        style={{ '--node-swatch': swatch } as CSSProperties}
      >
        <NodeChrome
          title={d.title ?? ''}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          onAddComment={(text) =>
            rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          onRefresh={() => setVersion((v) => v + 1)}
          searchOpen={filterOpen} onToggleSearch={() => setFilterOpen((o) => !o)}
          maximized={maximized}
          onToggleMaximize={() => { rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized((m) => !m) }}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />

        <div className="node-body files-node">
          <VscodeBreadcrumbs
            className="nodrag files-crumbs"
            ariaLabel="Folder path"
            segments={crumbs.map((c, i) => ({
              id: `${c.path}:${i}`,
              label: c.name,
              title: c.path,
              onClick: () => navigate(c.path, cwd),
            }))}
          />

          {filterOpen && (
            <Textfield
              ref={(node) => { filterRef.current = node }}
              className="files-filter nodrag" value={query} placeholder="Filter…"
              onInput={(e) => setQuery((e.target as unknown as { value: string }).value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setFilterOpen(false) }}
            />
          )}

          <div ref={listRef} className="files-list nodrag nowheel" tabIndex={0} onKeyDown={onListKeyDown}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null }) }}
          >
            {/* Baris memakai `vscode-tree-item` (22px, hover/selection dari VS Code). Handler
                dipasang di span DI DALAM slot, bukan di host: klik bawaan komponen berhenti di
                shadow DOM, sedangkan event dari konten slotted melewati target itu lebih dulu. */}
            <Tree ref={(node) => { treeRef.current = node }} className="files-tree" hideArrows indentGuides="none">
              {shown.map((e, i) => (
                <TreeItem key={e.name} data-index={i} selected={i === sel} active={i === sel}>
                  <span
                    data-index={i}
                    className={`files-row${i === sel ? ' files-row--sel' : ''}${e.ignored ? ' files-row--ignored' : ''}`}
                  >
                    <span className={`${e.dir ? folderIconClass(false) : fileIconClass(e.name)} files-icon`} aria-hidden="true" />
                    <span className="files-name">{e.name}</span>
                  </span>
                </TreeItem>
              ))}
            </Tree>

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
              <div className="files-empty files-welcome">
                <p>This folder is empty.</p>
                <VscodeButton onClick={() => { void createEntry(false) }}>New File…</VscodeButton>
              </div>
            )}
            {!loading && entries.length > 0 && shown.length === 0 && (
              <div className="files-empty">Nothing matches “{query.trim()}”.</div>
            )}
          </div>

          <div className="files-foot">{notice || `${shown.length} of ${entries.length}`}</div>
        </div>
      </div>

      {menu && <NodeContextMenu x={menu.x} y={menu.y} rows={menuRows} onClose={() => setMenu(null)} />}
    </>
  )
}

export default memo(FilesNode)
