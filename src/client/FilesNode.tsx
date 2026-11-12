// Node file-manager: a folder TREE rooted at `dirPath` (rows keyed by path relative to it). Ported
// from nodeterm `FilesNode.tsx` + Explorer `TreeEntry`; pure decisions live in `./fileBrowse.ts`,
// `./filesView.ts`, `./filesSelection.ts`, `./filesTree.ts` and `./filesKeys.ts`. This file is frame +
// state; tree state in `useFilesTree`, hand actions in `useFilesActions`, list in `FilesList`, row in
// `FilesRow`, name input in `FilesInput`, menu in `FilesMenu`; features plug in via `FILES_SLOTS`.
//
// TANPA FILE WATCHER di sini: refresh `⟳` manual menaikkan `version`; watcher adalah slot sendiri.
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import { Textfield } from '@/vscode/register'
import type { FileMeta } from '../shared/fsContract'
import type { Comment, ViewOpts } from '../shared/workspace'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { VscodeBreadcrumbs } from './components/vscode/vscodeBreadcrumbs'
import { breadcrumbs, childPath, folderTitle } from './fileBrowse'
import FilesList from './FilesList'
import FilesMenu from './FilesMenu'
import FilesToolbar from './FilesToolbar'
import { decorateEntry } from './FilesRow'
import { scrollTopToReveal } from './filesKeys'
import { EMPTY_SEL, indexOfName, selectedNames, selectOne, type Sel } from './filesSelection'
import { renameAt } from './filesSlot.mutate'
import { FILES_SLOTS, type FilesSlotCtx } from './filesSlots'
import { filterRows } from './filesTree'
import { dismissNotice, forgetFilesNotices, notify } from './filesNotice'
import { FilesNoticeLine, FilesProgressBar } from './FilesNoticeLine'
import { needsMeta, viewOf } from './filesView'
import { randomId } from './randomId'
import { rowElement, useFilesActions, type Menu } from './useFilesActions'
import { useFilesInput } from './useFilesInput'
import { useFilesListing } from './useFilesListing'
import { useFilesOpen } from './useFilesOpen'
import { useFilesTree } from './useFilesTree'
import './files.css'

const COLLAPSED_H = 40
/** Segmen breadcrumb terlihat sebelum sisanya masuk menu "…". */
const CRUMBS_MAX_VISIBLE = 4
/** Notice id of the node's own messages (reveal/copy/create/open); one at a time, cleared on cd. */
const NODE_NOTICE = 'node'

/** Footer count: "10 items", or "3 of 10 shown" only while the filter narrows the tree. */
export function footCount(shown: number, all: number, query: string): string {
  return query.trim() ? `${shown} of ${all} shown` : `${all} ${all === 1 ? 'item' : 'items'}`
}

/** Header title: the folder name. The root has none, so the header is just the node's name (no "· /"); the path stays in the tooltip. */
const rootlessTitle = (cwd: string): string => (cwd.split('/').some(Boolean) ? folderTitle(cwd) : '')

function FilesNode({ id, data, selected, height }: NodeProps) {
  const d = data as {
    dirPath?: string; color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[]; viewOpts?: ViewOpts
    expanded?: string[]
  }
  const rf = useReactFlow()
  const listRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement | null>(null)
  const filterRef = useRef<HTMLElement | null>(null)
  /** Relative path that terpilih begitu listing berikutnya mendarat (naik / entri baru). */
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

  // Filter and selection (and the name input, in `useFilesInput`) belong to ONE root folder; carrying
  // them to the next makes it look empty because of a box the user no longer sees.
  useEffect(() => { setQuery(''); dismissNotice(id, NODE_NOTICE); setSel(EMPTY_SEL) }, [cwd, id])
  // Unmount = node removed (the tab portal keeps the subtree mounted across layout moves).
  useEffect(() => () => forgetFilesNotices(id), [id])

  const tree = useFilesTree({ id, cwd, version, view, root: entries, initial: d.expanded })
  const all = useMemo(() => tree.rows.map((r) => r.entry), [tree.rows])
  const shown = useMemo(() => filterRows(tree.rows, query), [tree.rows, query])
  const cursor = indexOfName(shown.map((r) => r.entry), sel.cursor)
  const refresh = () => setVersion((v) => v + 1)
  const { navigate, addNodeBeside, open, openFile } = useFilesOpen({ id, cwd, title: d.title, swatch, setNotice, pendingSel })

  const input = useFilesInput({ cwd, listRef, pendingSel, refresh, setNotice, openFile: (p) => openFile(p, { focusEditor: true }) })
  const ctx: FilesSlotCtx = {
    cwd, dir: cwd, entries: all, selection: selectedNames(all, sel), open, nodeId: id,
    expanded: tree.expanded, toggle: tree.toggle, collapseAll: tree.collapseAll,
    startRenameAt: (rel) => renameAt(ctx, rel),
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
    const row = rowElement(listRef.current, cursor)
    if (box && row) box.scrollTop = scrollTopToReveal(row.offsetTop, row.offsetHeight, box.scrollTop, box.clientHeight)
  }, [cursor])

  // `autofocus` hanya berlaku saat elemen pertama kali dipasang, sedangkan filter dibuka-tutup.
  useEffect(() => { if (filterOpen) filterRef.current?.focus() }, [filterOpen])

  const act = useFilesActions({
    cwd, root: rootRef.current, rows: shown, cursor, sel, setSel, query, clearQuery: () => setQuery(''),
    listRef, ctx, setMenu, setNotice, navigate, openFile,
  })

  const startCreate = (dir: boolean, target: FileMeta | null = menu?.entry ?? null) => {
    // Create INSIDE a clicked folder but BESIDE a clicked file; the folder opens so the input shows under it.
    const at = act.createAt(target)
    setMenu(null)
    if (at) tree.setOpen(at, true)
    input.start({ kind: dir ? 'folder' : 'file', base: at ? childPath(cwd, at) : cwd, ...(at ? { at } : {}) })
  }

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? 300; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
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
          title={d.title || rootlessTitle(cwd)} name={d.name} icon="folder" titleHint={cwd}
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
            <FilesToolbar
              view={view} ctx={ctx} onChange={(v) => rf.updateNodeData(id, { viewOpts: v })} onRefresh={refresh}
              // Title-bar New File/Folder targets the cursor row (VS Code: the focused item), else the root.
              onNew={(dir) => startCreate(dir, shown[cursor]?.entry ?? null)}
            />
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
            nodeId={id} cwd={cwd} rows={shown} total={entries.length} sel={sel}
            loading={loading} verdict={verdict} query={query} decorate={decorate}
            listRef={listRef} treeRef={treeRef}
            inputRow={input.row} inputAt={input.at}
            onPick={act.onPick} onToggle={act.toggle} onOpen={(rel) => act.openRel(rel, false)}
            onRename={(rel) => ctx.startRenameAt(rel)} onContext={act.onContext}
            onKeyDown={act.onListKeyDown} onRetry={refresh} onNewFile={() => startCreate(false)}
          />

          {/* Wilayah live: notice (mis. "Sudah ada: x") dibacakan pembaca layar tanpa memindahkan fokus. */}
          <div className="files-foot" role="status" aria-live="polite">
            <FilesNoticeLine nodeId={id} fallback={`${footCount(shown.length, tree.rows.length, query)}${ctx.selection.length > 1 ? ` · ${ctx.selection.length} selected` : ''}`} />
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
            open: (e) => open(e, { focusEditor: true }),
            terminal: () => addNodeBeside(randomId(), 'terminal', { cwd: menu.entry?.dir ? menuTarget : cwd }),
            newEntry: startCreate,
            refresh,
            reveal: act.reveal,
            copyPath: (relative) => act.copy(menu.entry, relative),
          }}
        />
      )}
    </>
  )
}

export default memo(FilesNode)
