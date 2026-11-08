// Manifest slot FilesNode (PLAN/FILEMANAGER-b.md §5.4): FilesNode merender `FILES_SLOTS` tanpa tahu
// isinya; tiap fitur mengisi file slot-nya sendiri dan menyaring diri via `capabilities`.
import type { KeyboardEvent, ReactNode } from 'react'
import type { FileMeta } from '../shared/fsContract'
import type { MenuItem, MenuRow } from './NodeContextMenu'
import type { NoticeInput } from './filesNotice'
import { dndSlot } from './filesSlot.dnd'
import { gitSlot } from './filesSlot.git'
import { mutateSlot } from './filesSlot.mutate'
import { searchSlot } from './filesSlot.search'
import { treeSlot } from './filesSlot.tree'
import { uploadSlot } from './filesSlot.upload'
import { watchSlot } from './filesSlot.watch'

/** Inline name input request from a slot: create file/folder (FilesNode creates it) or rename.
 *  `at` = path RELATIVE to cwd of the row the input renders on (rename) / under (create). */
export type InputRequest =
  | { kind: 'file' | 'folder'; base?: string; at?: string }
  | { kind: 'rename'; initial: string; onCommit(name: string): void | Promise<void>; at?: string }

/** Baris menu slot; `keybinding` (teks shortcut) opsional dan hanya ditampilkan. */
export type SlotMenuRow = (MenuItem & { keybinding?: string }) | Extract<MenuRow, { type: 'separator' }>

export interface FilesSlotCtx {
  cwd: string
  dir: string
  /** Visible tree rows, in display order; each `name` is the path RELATIVE to cwd ("src/a.ts"). */
  entries: FileMeta[]
  /** Selected rows as paths relative to cwd (not indexes). */
  selection: string[]
  /** Folders currently expanded in the tree (relative paths). */
  expanded: ReadonlySet<string>
  /** Expand/collapse the folder at relative path `rel`. */
  toggle(rel: string): void
  /** Collapse every expanded folder. */
  collapseAll(): void
  /** Start the inline rename input on row `rel` (the mutate slot owns the actual rename). */
  startRenameAt(rel: string): void
  /** Reload the listing (expanded folders too); `select` = relative path to select once it lands. */
  refresh(select?: string): void
  /** Tampilkan input nama inline (pengganti prompt); Enter -> commit, Esc/blur -> batal. */
  startInput(req: InputRequest): void
  open(entry: FileMeta): void
  nodeId: string
  /** Show a notice in the node footer (the only text surface; upsert by `id`); returns its id. */
  notify(n: NoticeInput): string
  /** Remove notice `id` from the footer. */
  dismiss(id: string): void
}
export interface Decoration { badge?: string; title?: string; className?: string }

export interface FilesSlot {
  id: string
  menu?(ctx: FilesSlotCtx): SlotMenuRow[]
  /** true = tombol ditangani slot (FilesNode berhenti memproses). */
  onKey?(e: KeyboardEvent, ctx: FilesSlotCtx): boolean
  /** `entry.name` is the path relative to cwd; the row renders only its last segment. */
  decorate?(entry: FileMeta, ctx: FilesSlotCtx): Decoration | undefined
  /** Icon controls only (no visible text; filesToolbarPolicy.test locks this). Messages go to `ctx.notify`. */
  toolbar?(ctx: FilesSlotCtx): ReactNode
  /** Rendered right-aligned in the node footer, after the notice/count text, in FILES_SLOTS order. */
  footer?(ctx: FilesSlotCtx): ReactNode
  /** Dirender di samping node (dialog/toast); komponen sendiri yang memutuskan kapan terlihat. */
  overlay?(ctx: FilesSlotCtx): ReactNode
  /** Hook dipanggil tiap render FilesNode (urutan tetap, jadi aman untuk aturan hooks). */
  useSlot?(ctx: FilesSlotCtx): void
}

/** Fixed order: mutate, git, watch, search, dnd, upload, tree. */
export const FILES_SLOTS: readonly FilesSlot[] = [mutateSlot, gitSlot, watchSlot, searchSlot, dndSlot, uploadSlot, treeSlot]
