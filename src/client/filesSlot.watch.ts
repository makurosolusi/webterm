// Slot watch (WS-FM-07, flag WATCH): berlangganan perubahan direktori node ke server dan memuat ulang
// listing saat ada perubahan dari luar. Mutasi lokal (origin 'local') sudah me-refresh sendiri.
import { useEffect, useRef } from 'react'
import type { FilesSlot, FilesSlotCtx } from './filesSlots'
import { onFsEvent } from './fsEvents'
import { capabilities } from './fsClient'
import { onReconnect, send } from './ws'

// Beberapa node bisa membuka dir yang sama, sedangkan server menghitung langganan per KLIEN ws:
// fswatch dikirim pada 0->1 dan fsunwatch pada 1->0.
const subscribers = new Map<string, number>()
// Klien ws baru = nol langganan di server, padahal `subscribers` masih mengira aktif: kirim ulang.
onReconnect(() => { for (const [dir, n] of subscribers) if (n > 0) send({ t: 'fswatch', dir }) })
function useWatchDir(ctx: FilesSlotCtx): void {
  const { dir } = ctx
  const refreshRef = useRef(ctx.refresh)
  refreshRef.current = ctx.refresh
  useEffect(() => {
    let live = true
    let subscribed = false
    // ponytail: satu GET capabilities per mount/ganti dir (tanpa cache); cache bersama bila terasa boros.
    Promise.resolve().then(() => capabilities()).then(({ watch }) => {
      if (!live || !watch) return
      subscribed = true
      const n = (subscribers.get(dir) ?? 0) + 1
      subscribers.set(dir, n)
      if (n === 1) send({ t: 'fswatch', dir })
    }).catch((err: unknown) => console.warn(`filesSlot.watch: capabilities failed for ${dir}`, err))
    const off = onFsEvent((e) => {
      if (e.kind === 'dirty' && e.origin === 'remote' && e.path === dir) refreshRef.current()
    })
    return () => {
      live = false
      off()
      if (!subscribed) return
      const n = (subscribers.get(dir) ?? 1) - 1
      if (n > 0) { subscribers.set(dir, n); return }
      subscribers.delete(dir)
      send({ t: 'fsunwatch', dir })
    }
  }, [dir])
}

export const watchSlot: FilesSlot = { id: 'watch', useSlot: useWatchDir }
