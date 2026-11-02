// Daftar shortcut yang BENAR-BENAR terpasang di webterm hari ini. nodeterm menaruh daftar ini di
// belakang tombol Help cluster kontrol lewat menu + panel; di sini satu overlay, karena dua dari
// empat baris menu nodeterm (bug report, dokumentasi) tidak punya tujuan di webterm.
// Tampilannya mengikuti editor Keyboard Shortcuts VS Code: tabel Command / Keybinding dengan chip `kbd`.
import { Fragment, useEffect } from 'react'
import { VscodeDialog } from '@/components/vscode/vscodeDialog'
import { detectDialogPlatform, type DialogPlatform } from '@/components/vscode/vscodeDialogButtons'
import './helpOverlay.css'

/** Satu kunci simbolis (`Mod`, `Shift`, ...) atau teks literal; string tunggal = gestur, bukan kunci. */
type Chord = readonly string[] | string

const SHORTCUTS: readonly (readonly [readonly Chord[], string])[] = [
  [[['Mod', 'K']], 'Cari node (command palette)'],
  [[['Mod', 'M']], 'Tukar preview Markdown pada node editor yang di-hover'],
  [[['Mod', 'S']], 'Simpan file di node editor'],
  [
    [['Mod', '+'], ['Mod', '−'], ['Mod', '0']],
    'Ukuran font terminal fokus — perlu "Zoom font via keyboard" di settings',
  ],
  [[['Mod', 'Shift', 'U']], 'Tampilkan atau sembunyikan panel Output (log sistem)'],
  [[['Shift', 'Enter']], 'Baris baru tanpa mengirim, di dalam terminal'],
  [[['Backspace'], ['Delete']], 'Hapus node atau edge yang terpilih'],
  [['Dobel-klik edge'], 'Hapus link context itu'],
  [[['Escape']], 'Tutup overlay ini, settings, atau filter'],
]

const MAC_LABELS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Backspace: '⌫', Delete: '⌦' }
const PC_LABELS: Record<string, string> = { Mod: 'Ctrl' }

function keyLabel(key: string, platform: DialogPlatform): string {
  return (platform === 'mac' ? MAC_LABELS : PC_LABELS)[key] ?? key
}

function Keybinding({ chord, platform }: { chord: Chord; platform: DialogPlatform }) {
  if (typeof chord === 'string') return <span className="help-shortcuts__gesture">{chord}</span>
  return (
    <span className="help-shortcuts__chord" data-slot="help-chord">
      {chord.map((key, index) => (
        <Fragment key={key}>
          {index > 0 && platform !== 'mac' ? <span className="help-shortcuts__plus">+</span> : null}
          <kbd className="help-kbd">{keyLabel(key, platform)}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

export default function HelpOverlay({ onClose, platform }: { onClose: () => void; platform?: string }) {
  const os = detectDialogPlatform(platform)
  // Escape ditangani dialog dan listener ini: dua jalur ke `onClose` aman (idempoten), dan listener
  // window menjaga kontrak lama bila fokus sedang di luar dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <VscodeDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="Keyboard Shortcuts"
      width={560}
      className="help-overlay"
    >
      <table className="help-shortcuts" data-slot="help-shortcuts">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Keybinding</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(([chords, what]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>
                {chords.map((chord, index) => (
                  <Fragment key={index}>
                    {index > 0 ? <span className="help-shortcuts__or">{' / '}</span> : null}
                    <Keybinding chord={chord} platform={os} />
                  </Fragment>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </VscodeDialog>
  )
}
