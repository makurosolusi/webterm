// Node file-manager. Diport dari nodeterm `src/renderer/nodes/FilesNode.tsx`; keputusannya (naik ke
// mana, breadcrumb apa, filter cocok apa) ada di `./fileBrowse.ts`, `./filesView.ts` dan
// `./filesSelection.ts` supaya bisa dites tanpa DOM. File ini kerangka + state; daftar di
// `FilesList`, baris di `FilesRow`, input nama di `FilesInput`, menu di `FilesMenu`, dan fitur
// tambahan masuk lewat `FILES_SLOTS` (kita tidak tahu isinya).
//
// TANPA FILE WATCHER di sini: refresh `⟳` manual menaikkan `version`; watcher adalah slot sendiri.
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { Textfield } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import type { Comment, ViewOpts } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import { breadcrumbs, childPath, createTargetDir, filterEntries, parentDir } from './fileBrowse'
import FilesList, { type PickMods } from './FilesList'
import FilesMenu from './FilesMenu'
import FilesToolbar from './FilesToolbar'
import { decorateEntry } from './FilesRow'
import { DEFAULT_PAGE_ROWS, listKeyAction, scrollTopToReveal, typeAhead, type ListKeyAction } from './filesKeys'
import {
  EMPTY_SEL, indexOfName, nfcName, selectAll, selectedNames, selectOne, selectRange, toggleName, type Sel,
} from './filesSelection'
import { FILES_SLOTS, type FilesSlotCtx } from './filesSlots'
import { dismissNotice, forgetFilesNotices, notify } from './filesNotice'
import { FilesNoticeLine, FilesProgressBar } from './FilesNoticeLine'
import { applyView, needsMeta, relativePath, viewOf } from './filesView'
import { randomId } from './randomId'
import { useFilesInput } from './useFilesInput'
import { useFilesListing } from './useFilesListing'
import { useFilesOpen } from './useFilesOpen'
import { revealPath } from './workspaceCreate/workspaceCreate.api'
import './files.css'

const COLLAPSED_H = 40
/** Tinggi baris `vscode-tree-item`; dasar hitung PageUp/PageDown. */
const ROW_H = 22
/** Segmen breadcrumb terlihat sebelum sisanya masuk menu "…". */
const CRUMBS_MAX_VISIBLE = 4
/** Notice id of the node's own messages (reveal/copy/create/open); one at a time, cleared on cd. */
const NODE_NOTICE = 'node'

type Menu = { x: number; y: number; entry: FileMeta | null }

function FilesNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    dirPath?: string; color?: string; title?: string; collapsed?: boolean; comments?: Comment[]; viewOpts?: ViewOpts
  }
  const rf = useReactFlow()
  const listRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement | null>(null)
  const filterRef = useRef<HTMLElement | null>(null)
  const typed = useRef({ buffer: '', at: 0 })
  /** Nama yang harus terpilih begitu listing berikutnya mendarat (naik / entri baru). */
  const pendingSel = useRef<string | null>(null)

  const cwd = d.dirPath ?? '/'
  // Akar "Relative Path": folder tempat node ini dipasang (tidak ada konteks workspace-cwd di sini).
  const rootRef = useRef(cwd)
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? '#0a84ff'
  const comments = d.comments ?? []
  const view = viewOf(d.viewOpts)

  const [sel, setSel] = useState<Sel>(EMPTY_SEL)
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const expandedH = useRef(height ?? 300)
  const setNotice = (text: string) => { if (text) notify(id, { id: NODE_NOTICE, kind: 'error', text }); else dismissNotice(id, NODE_NOTICE) }

  const { entries, loading, verdict } = useFilesListing(cwd, version, needsMeta(view), () => {
    const want = pendingSel.current
    pendingSel.current = null
    // Refresh biasa mempertahankan seleksi; hanya permintaan eksplisit (naik/buat baru) menggantinya.
    if (want !== null) setSel(selectOne(want))
  })

  // Filter dan seleksi (juga input nama, di `useFilesInput`) adalah pertanyaan tentang SATU direktori; membawanya ke direktori
  // berikutnya membuat folder tampak kosong karena kotak yang sudah tidak dilihat pengguna.
  useEffect(() => { setQuery(''); dismissNotice(id, NODE_NOTICE); setSel(EMPTY_SEL) }, [cwd, id])
  // Unmount = node removed (the tab portal keeps the subtree mounted across layout moves).
  useEffect(() => () => forgetFilesNotices(id), [id])

  const shown = useMemo(
    () => filterEntries(applyView(entries, view), query),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `view` dipecah ke field supaya identitas objek tak memicu hitung ulang
    [entries, view.hidden, view.sortKey, view.sortDir, query],
  )
  const cursor = indexOfName(shown, sel.cursor)
  const refresh = () => setVersion((v) => v + 1)
  const { navigate, addNodeBeside, open, openFile } = useFilesOpen({ id, cwd, title: d.title, swatch, setNotice, pendingSel })

  const input = useFilesInput({ cwd, listRef, pendingSel, refresh, setNotice, openFile })
  const ctx: FilesSlotCtx = {
    cwd, dir: cwd, entries, selection: selectedNames(entries, sel), open, nodeId: id,
    refresh: (select) => { if (select) pendingSel.current = select; refresh() },
    startInput: input.start,
    notify: (n) => notify(id, n), dismiss: (nid) => dismissNotice(id, nid),
  }
  // Urutan FILES_SLOTS tetap, jadi jumlah hook per render konstan.
  for (const s of FILES_SLOTS) s.useSlot?.(ctx)
  const decorate = (e: FileMeta) => decorateEntry(FILES_SLOTS, e, ctx)

  // Gulirkan kursor ke dalam pandangan setiap kali ia pindah (keyboard, klik).
  // `scrollIntoView` juga menggulirkan ancestor — di canvas itu menyeret seluruh pane React Flow.
  useEffect(() => {
    const box = listRef.current
    const row = treeRef.current?.children[cursor] as HTMLElement | undefined
    if (box && row) box.scrollTop = scrollTopToReveal(row.offsetTop, row.offsetHeight, box.scrollTop, box.clientHeight)
  }, [cursor])

  // `autofocus` hanya berlaku saat elemen pertama kali dipasang, sedangkan filter dibuka-tutup.
  useEffect(() => { if (filterOpen) filterRef.current?.focus() }, [filterOpen])

  const copy = (entry: FileMeta | null, relative: boolean) => {
    const target = entry ? childPath(cwd, entry.name) : cwd
    const text = relative ? relativePath(rootRef.current, target) : target
    // Clipboard API menolak di konteks tak aman / tanpa izin; katakan, jangan diam.
    navigator.clipboard?.writeText(text).catch(() => setNotice('Could not copy the path.'))
  }

  /** Show the entry in the OS file manager (Finder / File Explorer); the server runs it. */
  const reveal = (entry: FileMeta) => {
    revealPath(childPath(cwd, entry.name)).catch((e: unknown) =>
      setNotice(`Could not reveal “${entry.name}”: ${e instanceof Error ? e.message : String(e)}`))
  }

  const startCreate = (dir: boolean) => {
    // Buat DI DALAM folder yang diklik, tapi DI SAMPING file yang diklik.
    const base = menu?.entry ? createTargetDir(childPath(cwd, menu.entry.name), menu.entry.dir) : cwd
    setMenu(null)
    input.start({ kind: dir ? 'folder' : 'file', base })
  }

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const onPick = (index: number, mods: PickMods) => {
    const e = shown[index]
    if (!e) return
    setSel((s) => (mods.shift ? selectRange(s, shown, index) : mods.toggle ? toggleName(s, e.name) : selectOne(e.name)))
  }

  const onContext = (index: number | null, x: number, y: number) => {
    const e = index === null ? null : shown[index]
    // Klik kanan pada baris di luar seleksi memilih baris itu; di dalam seleksi, seleksi dipertahankan.
    if (e && !sel.names.has(nfcName(e.name))) setSel(selectOne(e.name))
    setMenu({ x, y, entry: e ?? null })
  }

  const run = (act: NonNullable<ListKeyAction>) => {
    const at = shown[act.kind === 'select' || act.kind === 'open' ? act.index : -1]
    switch (act.kind) {
      case 'up': navigate(parentDir(cwd), cwd); break
      case 'open': if (at && (!act.dirOnly || at.dir)) open(at); break
      case 'select': if (at) setSel(act.extend ? selectRange(sel, shown, act.index) : selectOne(at.name)); break
      case 'selectAll': setSel(selectAll(sel, shown)); break
      case 'copyPath': copy(shown[cursor] ?? null, act.relative); break
      case 'reveal': if (shown[cursor]) reveal(shown[cursor]); break
      case 'menu': {
        const rect = (treeRef.current?.children[cursor] ?? listRef.current)?.getBoundingClientRect()
        setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, entry: shown[cursor] ?? null })
        break
      }
      // 'rename'/'delete': tombol diklaim (Delete tak boleh menghapus NODE) dan sudah ditawarkan ke
      // slot lewat `onKey` di atas; aksi nyatanya milik slot mutate (filesSlot.mutate).
      default: break
    }
  }

  const onListKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    // Canvas React Flow membajak keyboard: panah mem-pan, dan BACKSPACE/DELETE MENGHAPUS NODE INI.
    // Setiap tombol yang kita tangani harus diklaim di sini, bukan hanya di-preventDefault.
    const claim = () => { ev.preventDefault(); ev.stopPropagation() }
    if (FILES_SLOTS.some((s) => s.onKey?.(ev, ctx))) { claim(); return }
    const box = listRef.current
    const page = box && box.clientHeight > 0 ? Math.floor(box.clientHeight / ROW_H) : DEFAULT_PAGE_ROWS
    const act = listKeyAction(
      { key: ev.key, code: ev.code, alt: ev.altKey, meta: ev.metaKey, ctrl: ev.ctrlKey, shift: ev.shiftKey },
      cursor, shown.length, page,
    )
    if (act) { claim(); run(act); return }
    if (ev.key === 'Escape' && query) { claim(); setQuery(''); return }
    if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      claim()
      const next = typeAhead(typed.current, ev.key, Date.now(), shown.map((e) => e.name), cursor)
      typed.current = next.state
      if (next.index >= 0) setSel(selectOne(shown[next.index].name))
    }
  }

  const crumbs = breadcrumbs(cwd, Number.MAX_SAFE_INTEGER)
  const menuTarget = menu?.entry ? childPath(cwd, menu.entry.name) : cwd

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={240} minHeight={160} color={swatch} />
      <div
        className={termNodeClass({ selected: !!selected, collapsed })}
        style={{ '--node-swatch': swatch } as CSSProperties}
      >
        <NodeChrome
          title={d.title ?? ''} icon="folder" description={cwd}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          onAddComment={(text) =>
            rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          onRefresh={refresh}
          searchOpen={filterOpen} onToggleSearch={() => setFilterOpen((o) => !o)}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />

        <div className="node-body files-node">
          <div className="files-bar">
            <VscodeBreadcrumbs
              className="nodrag files-crumbs"
              ariaLabel="Folder path"
              maxVisible={CRUMBS_MAX_VISIBLE}
              segments={crumbs.map((c, i) => ({
                id: `${c.path}:${i}`,
                label: c.name,
                title: c.path,
                onClick: () => navigate(c.path, cwd),
              }))}
            />
            <FilesToolbar view={view} ctx={ctx} onChange={(v) => rf.updateNodeData(id, { viewOpts: v })} />
          </div>

          {filterOpen && (
            <Textfield
              ref={(node) => { filterRef.current = node }}
              className="files-filter nodrag" value={query} placeholder="Filter…"
              onInput={(e) => setQuery((e.target as unknown as { value: string }).value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setFilterOpen(false) }}
            />
          )}

          <FilesProgressBar nodeId={id} />
          <FilesList
            nodeId={id} cwd={cwd} shown={shown} total={entries.length} sel={sel}
            loading={loading} verdict={verdict} query={query} decorate={decorate}
            listRef={listRef} treeRef={treeRef}
            inputRow={input.row}
            onPick={onPick} onOpen={(i) => shown[i] && open(shown[i])} onContext={onContext}
            onKeyDown={onListKeyDown} onRetry={refresh} onNewFile={() => startCreate(false)}
          />

          {/* Wilayah live: notice (mis. "Sudah ada: x") dibacakan pembaca layar tanpa memindahkan fokus. */}
          <div className="files-foot" role="status" aria-live="polite">
            <FilesNoticeLine nodeId={id} fallback={`${shown.length} of ${entries.length}${ctx.selection.length > 1 ? ` · ${ctx.selection.length} selected` : ''}`} />
            {FILES_SLOTS.map((s) => s.footer && <Fragment key={s.id}>{s.footer(ctx)}</Fragment>)}
          </div>
        </div>
      </div>

      {FILES_SLOTS.map((s) => s.overlay && <Fragment key={s.id}>{s.overlay(ctx)}</Fragment>)}

      {menu && (
        <FilesMenu
          x={menu.x} y={menu.y} entry={menu.entry}
          slotRows={FILES_SLOTS.flatMap((s) => s.menu?.(ctx) ?? [])}
          onClose={() => setMenu(null)}
          actions={{
            open,
            terminal: () => addNodeBeside(randomId(), 'terminal', { cwd: menu.entry?.dir ? menuTarget : cwd }),
            newEntry: startCreate,
            refresh,
            reveal,
            copyPath: (relative) => copy(menu.entry, relative),
          }}
        />
      )}
    </>
  )
}

export default memo(FilesNode)
