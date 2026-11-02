import { useEffect, useRef, useState } from 'react'

/** Tujuan portal overlay: elemen fullscreen aktif (hanya ia dan turunannya tampil di top layer), kalau tidak `document.body`. Dihitung saat dipanggil. */
export function portalContainer(): HTMLElement {
  return (document.fullscreenElement as HTMLElement | null) ?? document.body
}

/** Jalankan `fn` tiap `fullscreenchange`; overlay transien memakainya untuk menutup diri alih-alih pindah container. */
export function useOnFullscreenChange(fn: () => void, active = true): void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!active) return
    const on = () => fnRef.current()
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [active])
}

/** Seperti `portalContainer()` tapi render ulang saat fullscreen berubah, untuk overlay yang menetap (stack toast). */
export function usePortalContainer(): HTMLElement {
  const [, bump] = useState(0)
  useOnFullscreenChange(() => bump((n) => n + 1))
  return portalContainer()
}
