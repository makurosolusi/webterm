import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { NODE_ROOT } from './nodeRoot'

/** Elemen yang di-fullscreen: wrapper node React Flow, atau pane tab (UA `:fullscreen` menimpa transform/ukuran inline-nya). */
export const FULLSCREEN_TARGET = NODE_ROOT

/** Fullscreen sungguhan (Fullscreen API) untuk wrapper node yang memuat `anchor`; state dibaca dari `document.fullscreenElement`. */
export function useNodeFullscreen(anchor: RefObject<HTMLElement | null>) {
  const target = useCallback(() => anchor.current?.closest<HTMLElement>(FULLSCREEN_TARGET) ?? null, [anchor])
  const [isFullscreen, setFullscreen] = useState(false)
  const [available] = useState(() => typeof document !== 'undefined' && document.fullscreenEnabled === true)

  // Sumber kebenaran = event browser, bukan state lokal: Esc keluar tanpa lewat toggle().
  useEffect(() => {
    const sync = () => {
      const el = target()
      setFullscreen(el !== null && document.fullscreenElement === el)
    }
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [target])

  const toggle = useCallback(() => {
    const el = target()
    if (!available || !el) return
    const warn = (op: string, e: unknown) =>
      console.warn(`[useNodeFullscreen] ${op} gagal: ${e instanceof Error ? e.name : typeof e}`)
    const run = (op: 'requestFullscreen' | 'exitFullscreen', call: () => Promise<void> | undefined) => {
      try {
        // Penolakan browser (mis. tanpa user gesture) dicatat, tidak jadi unhandled rejection.
        void Promise.resolve(call()).catch((e) => warn(op, e))
      } catch (e) {
        warn(op, e) // requestFullscreen bisa melempar sinkron di browser lama
      }
    }
    if (document.fullscreenElement === el) run('exitFullscreen', () => document.exitFullscreen?.())
    else run('requestFullscreen', () => el.requestFullscreen?.())
  }, [target, available])

  return { isFullscreen, fullscreenDisabled: !available, toggle }
}
