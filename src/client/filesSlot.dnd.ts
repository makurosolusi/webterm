// Slot DnD path (WS-FM-09): baris file/folder bisa diseret; payload = path dikutip shell (MIME
// `application/x-webterm-path` + `text/plain`), multi-seleksi digabung spasi. Plus menu "Copy Path
// (Shell-quoted)". Menjatuhkan ke terminal TIDAK dipasang di sini (TerminalNode bukan milik slot ini, lihat R-09).
// Dikunci `capabilities().quickOpen` (flag QUICK_OPEN), fail-closed.
import { useEffect, useRef } from 'react'
import { childPath } from './fileBrowse'
import { useQuickOpenEnabled } from './filesSlot.search'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'

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

export const dndSlot: FilesSlot = {
  id: 'dnd',
  useSlot(ctx: FilesSlotCtx) {
    const on = useQuickOpenEnabled()
    const live = useRef(ctx)
    live.current = ctx
    useEffect(() => { enabled = on }, [on])
    const nodeEl = () => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`)
    // Tanpa deps: baris baru muncul tiap listing berubah, dan atribut `draggable` tidak dimiliki React.
    useEffect(() => {
      if (on) nodeEl()?.querySelectorAll(ROW).forEach((r) => r.setAttribute('draggable', 'true'))
    })
    useEffect(() => {
      const el = on ? nodeEl() : null
      if (!el) return
      const onDragStart = (e: DragEvent) => {
        const row = e.target instanceof Element ? e.target.closest(ROW) : null
        const name = row?.querySelector('.files-name')?.textContent
        if (!name || !e.dataTransfer) return
        const text = shellQuoteAll(dragNames(name, live.current.selection).map((n) => childPath(live.current.dir, n)))
        e.dataTransfer.setData(DND_MIME, text)
        e.dataTransfer.setData('text/plain', text)
        e.dataTransfer.effectAllowed = 'copy'
      }
      el.addEventListener('dragstart', onDragStart)
      return () => el.removeEventListener('dragstart', onDragStart)
    }, [on, ctx.nodeId])
  },
  menu(ctx) {
    if (!enabled || ctx.selection.length === 0) return []
    const text = shellQuoteAll(ctx.selection.map((n) => childPath(ctx.dir, n)))
    return [{
      label: DND_TEXT.copyQuoted,
      onClick: () => {
        // Clipboard API menolak di konteks tak aman / tanpa izin; catat, jangan diam.
        navigator.clipboard?.writeText(text).catch((err: unknown) => console.error('files dnd: copy quoted path failed', err))
      },
    }]
  },
}
