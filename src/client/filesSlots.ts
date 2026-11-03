// Manifest slot FilesNode (PLAN/FILEMANAGER-b.md §5.4): FilesNode merender `FILES_SLOTS` tanpa tahu
// isinya; tiap fitur mengisi file slot-nya sendiri dan menyaring diri via `capabilities`.
import type { KeyboardEvent, ReactNode } from 'react'
import type { FileMeta } from '../shared/fsContract'
import type { MenuRow } from './NodeContextMenu'
import { dndSlot } from './filesSlot.dnd'
import { gitSlot } from './filesSlot.git'
import { mutateSlot } from './filesSlot.mutate'
import { searchSlot } from './filesSlot.search'
import { uploadSlot } from './filesSlot.upload'
import { watchSlot } from './filesSlot.watch'

export interface FilesSlotCtx {
  cwd: string
  dir: string
  entries: FileMeta[]
  /** Nama entri terpilih (bukan indeks). */
  selection: string[]
  refresh(): void
  open(entry: FileMeta): void
  nodeId: string
}
export interface Decoration { badge?: string; title?: string; className?: string }

export interface FilesSlot {
  id: string
  menu?(ctx: FilesSlotCtx): MenuRow[]
  /** true = tombol ditangani slot (FilesNode berhenti memproses). */
  onKey?(e: KeyboardEvent, ctx: FilesSlotCtx): boolean
  decorate?(entry: FileMeta, ctx: FilesSlotCtx): Decoration | undefined
  toolbar?(ctx: FilesSlotCtx): ReactNode
  /** Hook dipanggil tiap render FilesNode (urutan tetap, jadi aman untuk aturan hooks). */
  useSlot?(ctx: FilesSlotCtx): void
}

/** Urutan tetap: mutate, git, watch, search, dnd, upload. */
export const FILES_SLOTS: readonly FilesSlot[] = [mutateSlot, gitSlot, watchSlot, searchSlot, dndSlot, uploadSlot]
