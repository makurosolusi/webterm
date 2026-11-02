// Daftar shortcut yang BENAR-BENAR terpasang di webterm hari ini. nodeterm menaruh daftar ini di
// belakang tombol Help cluster kontrol lewat menu + panel; di sini satu overlay, karena dua dari
// empat baris menu nodeterm (bug report, dokumentasi) tidak punya tujuan di webterm.
import { useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  // Escape ditangani Dialog (Radix) dan listener ini: dua jalur ke `onClose` aman, dan listener
  // window menjaga kontrak lama bila fokus sedang di luar dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        // `palette` tetap memegang ukuran/permukaan; util di sini hanya menetralkan bingkai
        // DialogContent (p-6, gap-4, center) supaya posisi dan padded list tidak berubah.
        className="palette nodrag nowheel z-[60] gap-0 p-0 top-[12vh] translate-y-0 motion-reduce:animate-none"
        aria-label="Keyboard shortcuts"
        showCloseButton={false}
      >
        {/* Radix memfokuskan viewport saat dialog dibuka; ring/outline di situ bukan penanda
            kontrol (daftar ini memang tak punya kontrol), hanya kotak baru. */}
        <ScrollArea className="palette__list flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]]:focus-visible:ring-0 [&_[data-slot=scroll-area-viewport]]:focus-visible:outline-none">
          <DialogTitle className="palette__section" style={{ margin: 0 }}>Keyboard shortcuts</DialogTitle>
          {SHORTCUTS.map(([chord, what]) => (
            <div key={chord} className="palette__item">
              <span>{what}</span>
              <span className="palette__hint">{chord}</span>
            </div>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
