// Slot DnD path (WS-FM-09): baris file/folder bisa diseret; payload = path dikutip shell (MIME
// `application/x-webterm-path` + `text/plain`, untuk drop ke terminal), multi-seleksi digabung spasi, plus
// menu "Copy Path (Shell-quoted)" (flag QUICK_OPEN). Bila `mutate` aktif, drag yang sama juga membawa
// `MOVE_MIME` untuk pindah/salin di dalam tree (filesSlot.dnd.drop). Fail-closed bila capabilities gagal.
import { useEffect, useRef, useState } from 'react'
import { childPath } from './fileBrowse'
import './filesSlot.dnd.css'
import { MOVE_MIME, rowAt, setDragged, useTreeDrop } from './filesSlot.dnd.drop'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'
import { capabilities } from './fsClient'

/** MIME internal pembawa path terkutip. */
export const DND_MIME = 'application/x-webterm-path'
/** Satu-satunya tempat string UI slot ini. */
export const DND_TEXT = { copyQuoted: 'Copy Path (Shell-quoted)' }

let enabled = false
/** Kembalikan state modul ke awal (untuk tes). */
export function resetDndSlot(): void { enabled = false }

/** Kutip satu path untuk shell POSIX: `'…'` dengan `'` di dalam menjadi `'\''`. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

/** Kutip tiap path lalu gabung spasi; tanpa newline akhir. */
export function shellQuoteAll(paths: readonly string[]): string {
  return paths.map(shellQuote).join(' ')
}

/** Nama yang ikut diseret: seluruh seleksi bila baris yang diseret ada di dalamnya, selain itu baris itu saja. */
export function dragNames(dragged: string, selection: readonly string[]): string[] {
  return selection.length > 1 && selection.includes(dragged) ? [...selection] : [dragged]
}

const ROW = 'vscode-tree-item[data-index]'

/** `quickOpen` = terminal path payload + copy menu; `mutate` = move/copy inside the tree. */
function useDndCaps(): { quickOpen: boolean; mutate: boolean } {
  const [caps, setCaps] = useState({ quickOpen: false, mutate: false })
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => capabilities()).then((c) => {
      if (alive) setCaps({ quickOpen: c.quickOpen, mutate: c.mutate })
    }).catch((err: unknown) => console.error('files dnd: capabilities failed, drag disabled', err))
    return () => { alive = false }
  }, [])
  return caps
}

export const dndSlot: FilesSlot = {
  id: 'dnd',
  useSlot(ctx: FilesSlotCtx) {
    const { quickOpen, mutate } = useDndCaps()
    const on = quickOpen || mutate
    const live = useRef(ctx)
    live.current = ctx
    useTreeDrop(ctx, mutate)
    useEffect(() => { enabled = quickOpen }, [quickOpen])
    const nodeEl = () => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`)
    // Tanpa deps: baris baru muncul tiap listing berubah, dan atribut `draggable` tidak dimiliki React.
    useEffect(() => {
      if (on) nodeEl()?.querySelectorAll(ROW).forEach((r) => r.setAttribute('draggable', 'true'))
    })
    useEffect(() => {
      const el = on ? nodeEl() : null
      if (!el) return
      const onDragStart = (e: DragEvent) => {
        const c = live.current
        const rel = rowAt(e.target, c)?.entry.name
        if (!rel || !e.dataTransfer) return
        const paths = dragNames(rel, c.selection).map((n) => childPath(c.cwd, n))
        if (quickOpen) {
          const text = shellQuoteAll(paths)
          e.dataTransfer.setData(DND_MIME, text)
          e.dataTransfer.setData('text/plain', text)
        }
        if (mutate) {
          e.dataTransfer.setData(MOVE_MIME, JSON.stringify(paths))
          setDragged(paths)
        }
        e.dataTransfer.effectAllowed = mutate ? 'copyMove' : 'copy'
      }
      const onDragEnd = () => setDragged(null)
      el.addEventListener('dragstart', onDragStart)
      el.addEventListener('dragend', onDragEnd)
      return () => { el.removeEventListener('dragstart', onDragStart); el.removeEventListener('dragend', onDragEnd) }
    }, [on, quickOpen, mutate, ctx.nodeId])
  },
  menu(ctx) {
    if (!enabled || ctx.selection.length === 0) return []
    const text = shellQuoteAll(ctx.selection.map((n) => childPath(ctx.cwd, n)))
    return [{
      label: DND_TEXT.copyQuoted,
      onClick: () => {
        // Clipboard API menolak di konteks tak aman / tanpa izin; catat, jangan diam.
        navigator.clipboard?.writeText(text).catch((err: unknown) => console.error('files dnd: copy quoted path failed', err))
      },
    }]
  },
}
