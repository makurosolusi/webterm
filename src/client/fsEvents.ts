// Bus event file manager (PLAN/FILEMANAGER-b.md §5.4): mutasi lokal `emit` setelah sukses, watcher
// `emit(origin:'remote')`. Konsumen: FilesNode (refresh), EditorNode (rename/delete), dekorasi git.
import type { FsEvent } from '../shared/fsContract'

type Listener = (e: FsEvent) => void
const listeners = new Set<Listener>()

/** Kirim `e` ke semua pendengar; pendengar yang melempar dicatat dan TIDAK menghentikan yang lain. */
export function emitFsEvent(e: FsEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e)
    } catch (err) {
      console.error(`fsEvents: listener failed for ${e.kind} ${e.path}`, err)
    }
  }
}

/** Dengarkan event; mengembalikan fungsi berhenti-mendengar. */
export function onFsEvent(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
