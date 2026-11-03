// Slot Quick Open (WS-FM-09): Ctrl/Cmd+P HANYA saat fokus ada di dalam node files ini (P-7), jadi tidak
// menangkap tombol di terminal/Monaco atau halaman. Dikunci `capabilities().quickOpen` (fail-closed).
import { useEffect, useState, useSyncExternalStore } from 'react'
import QuickOpen from './QuickOpen'
import { capabilities } from './fsClient'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'

let openNode: string | null = null
const subs = new Set<() => void>()
const setOpenNode = (id: string | null) => { openNode = id; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

/** Node yang Quick Open-nya terbuka (untuk tes). */
export const quickOpenNode = (): string | null => openNode
/** Kembalikan state modul ke awal (untuk tes). */
export function resetSearchSlot(): void { openNode = null; subs.clear() }

/** Hook: apakah server mengaktifkan Quick Open. Fail-closed; `capabilities` yang melempar sinkron tetap jadi penolakan. */
export function useQuickOpenEnabled(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => capabilities()).then((c) => {
      if (alive) setOn(c.quickOpen)
    }).catch((err: unknown) => {
      console.error('files quick-open: capabilities failed, feature disabled', err)
      if (alive) setOn(false)
    })
    return () => { alive = false }
  }, [])
  return on
}

const isQuickOpenKey = (e: KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p'

function QuickOpenHost({ ctx }: { ctx: FilesSlotCtx }) {
  const node = useSyncExternalStore(subscribe, () => openNode)
  if (node !== ctx.nodeId) return null
  // Entri hasil = path relatif ke cwd; `ctx.open` (jalur yang sama dengan dobel-klik) menyusunnya dengan childPath.
  return <QuickOpen root={ctx.cwd} onOpen={(rel) => ctx.open({ name: rel, dir: false, ignored: false })} onClose={() => setOpenNode(null)} />
}

export const searchSlot: FilesSlot = {
  id: 'search',
  useSlot(ctx) {
    const on = useQuickOpenEnabled()
    useEffect(() => {
      const el = on ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(ctx.nodeId)}"]`) : null
      if (!el) return
      const onKeyDown = (e: KeyboardEvent) => {
        if (!isQuickOpenKey(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOpenNode(ctx.nodeId)
      }
      el.addEventListener('keydown', onKeyDown)
      return () => el.removeEventListener('keydown', onKeyDown)
    }, [on, ctx.nodeId])
  },
  overlay: (ctx) => <QuickOpenHost ctx={ctx} />,
}
