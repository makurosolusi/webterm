import { useEffect, useState } from 'react'

/** Kunci persist keadaan terbuka/tertutup. Namanya warisan dari masa panel ini punya hover-peek
 *  (dulu "pinned" vs "peek"); JANGAN diganti — nilainya sudah tersimpan di browser pengguna. */
const PIN_KEY = 'webterm.sessionsPinned'

function readOpen(): boolean {
  // Mode privat / site data diblokir membuat sentuhan ke localStorage sendiri melempar;
  // default-nya tersemat (panel terbuka), jadi sidebar tetap jalan tanpa penyimpanan.
  try {
    return localStorage.getItem(PIN_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Keadaan buka/tutup panel + persistensinya, dipakai integrator (`App`). Hidup DI LUAR panel karena
 * tombol pembukanya ada di Dock: dua permukaan membaca satu keadaan, dan state di dalam panel
 * membuat panel yang tertutup jadi satu-satunya yang tahu ia tertutup.
 */
export function useSessionsOpen() {
  const [open, setOpen] = useState(readOpen)
  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, open ? '1' : '0')
    } catch {
      // Penyimpanan ditolak (mode privat): pilihan buka/tutup berlaku untuk sesi tab ini saja.
    }
  }, [open])
  return [open, setOpen] as const
}
