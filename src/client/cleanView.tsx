import { useCallback, useEffect, useState } from 'react'
import { isCleanViewChord, isMacPlatform } from './terminalKeys'
import { useCommandShortcut } from '@/components/ui/icon-button'
import './cleanView.css'

/**
 * Clean view — mode fokus. Satu kelas di `document.body` menyembunyikan seluruh chrome; canvas,
 * node, dan header tiap node tinggal. Semua penyembunyiannya CSS (`./cleanView.css`), BUKAN
 * unmount: panel yang di-unmount kehilangan state-nya (filter sesi, menu terbuka, scroll) dan
 * keluar dari clean view akan terasa seperti reload.
 *
 * TIDAK dipersist, sengaja: mendarat di halaman tanpa chrome setelah reload adalah cara paling
 * cepat membuat orang mengira aplikasinya rusak.
 *
 * Satu modul sendiri, bukan tambahan di `App.tsx` (392 baris) — batas rumahnya 500, dan hook +
 * petunjuk + konstanta ini akan mendorongnya melewati 80% batas itu.
 */

/** Kelas penanda di `document.body`. Satu-satunya nama yang dibagi JS dan `cleanView.css`. */
export const CLEAN_VIEW_CLASS = 'clean-view'

/**
 * Keadaan clean view plus pelontarnya.
 *
 * Jalan keluarnya chord, dan chord itu adalah `isCleanViewChord` yang DIIMPOR — bukan kondisi yang
 * ditulis ulang di sini. Di clean view semua chrome hilang, jadi keyboard satu-satunya jalan pulang,
 * dan fokus keyboard hampir selalu di dalam xterm yang menelan hampir semua tombol; `terminalKeys`
 * mengajari xterm mem-bubble-kan tepat chord ini ke window. Dua definisi chord yang terpisah pasti
 * menyimpang, dan yang menyimpang di sini mengurung pengguna.
 *
 * `Escape` SENGAJA tidak dipasang: di dalam terminal ia tombol yang paling sering dikirim orang
 * (keluar dari insert mode vim), dan listener window akan mematikan clean view setiap kali.
 */
export function useCleanView(): [boolean, () => void] {
  const [on, setOn] = useState(false)

  // `document.body`, bukan `.app-shell`: panel mengapung dan minimap memang anak app-shell, tapi
  // body satu-satunya simpul yang pasti membungkus apa pun yang menyusul, portal termasuk.
  useEffect(() => {
    document.body.classList.toggle(CLEAN_VIEW_CLASS, on)
    return () => document.body.classList.remove(CLEAN_VIEW_CLASS)
  }, [on])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Platform dibaca pada WAKTU EVENT, sama seperti keputusan chord di dalam terminal.
      if (!isCleanViewChord(e, isMacPlatform())) return
      e.preventDefault()
      setOn((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return [on, useCallback(() => setOn((v) => !v), [])]
}

/**
 * Petunjuk jalan keluar, satu-satunya hal yang MUNCUL di clean view. Tanpa ia, pengguna pertama
 * yang menekan tombolnya tidak punya cara tahu jalan pulang.
 *
 * Redupnya animasi CSS murni — tidak ada timer JS yang bisa bocor, dan tidak ada sistem toast yang
 * perlu dibangun (webterm tidak punya satu pun). Dirender hanya selagi clean view menyala, jadi
 * masuk ulang menyalakan animasinya dari awal.
 *
 * `role="status"` + `aria-live="polite"`: diumumkan tanpa pernah merebut fokus dari terminal.
 */
export function CleanViewHint() {
  const key = useCommandShortcut('view.cleanView') // the registry's fixed escape hatch, one source with the overlay
  return (
    <div className="clean-view-hint" role="status" aria-live="polite">
      Clean view — press <span className="kbd">{key}</span> to exit
    </div>
  )
}
