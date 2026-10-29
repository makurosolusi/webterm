// Daftar shortcut yang BENAR-BENAR terpasang di webterm hari ini. nodeterm menaruh daftar ini di
// belakang tombol Help cluster kontrol lewat menu + panel; di sini satu overlay, karena dua dari
// empat baris menu nodeterm (bug report, dokumentasi) tidak punya tujuan di webterm.
import { useEffect } from 'react'
import './canvas-ui.css'

const SHORTCUTS: readonly [string, string][] = [
  ['⌘K / Ctrl K', 'Cari node (command palette)'],
  ['⌘M / Ctrl M', 'Tukar preview Markdown pada node editor yang di-hover'],
  ['⌘S / Ctrl S', 'Simpan file di node editor'],
  ['⌘+ / ⌘− / ⌘0', 'Ukuran font terminal fokus — perlu "Zoom font via keyboard" di settings'],
  ['⇧Enter', 'Baris baru tanpa mengirim, di dalam terminal'],
  ['⌫ / Delete', 'Hapus node atau edge yang terpilih'],
  ['Dobel-klik edge', 'Hapus link context itu'],
  ['Escape', 'Tutup overlay ini, settings, atau filter'],
]

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="palette-overlay nodrag nowheel" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="palette__list">
          <div className="palette__section">Keyboard shortcuts</div>
          {SHORTCUTS.map(([chord, what]) => (
            <div key={chord} className="palette__item">
              <span>{what}</span>
              <span className="palette__hint">{chord}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
