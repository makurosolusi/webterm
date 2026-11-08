// Input nama inline untuk "New File…/New Folder…" dan Rename (pengganti `window.prompt`). Enter
// memasang, Escape membatalkan, blur memasang bila nama berubah dan sah (VS Code), selain itu batal;
// nama tak valid ditandai langsung dan Enter tidak melakukan apa pun.
import { useEffect, useRef, useState } from 'react'
import { Input } from './components/ui/input'
import { newEntryPath } from './fileBrowse'
import { NAME_NOT_ALLOWED } from './filesCreate'
import { nameProblemText } from './filesMessages'
import { checkName, stemEnd } from './filesName'

interface Props {
  dir: boolean
  /** Nama awal; bila ada, input berperan sebagai Rename (satu segmen, bagian sebelum ekstensi terpilih). */
  initial?: string
  /** Folder tempat entri dibuat; dipakai validasi dan label. */
  base: string
  onCommit: (name: string) => void
  /** `refocus`: true bila dibatalkan lewat Escape (fokus kembali ke daftar); false saat blur. */
  onCancel: (refocus: boolean) => void
}

export default function FilesInput({ dir, initial, base, onCommit, onCancel }: Props) {
  const rename = initial !== undefined
  const [value, setValue] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)
  // Enter/Escape unmount the input, which can still fire a blur: settle only once.
  const settled = useRef(false)
  useEffect(() => {
    const el = ref.current
    el?.focus()
    if (el && initial) el.setSelectionRange(0, stemEnd(initial))
  }, [initial])
  const check = rename ? checkName(value) : null
  const invalid = value.trim() !== '' && (rename ? !check?.ok : newEntryPath(base, value) === null)
  const label = rename ? 'New name' : dir ? 'New folder name' : 'New file name'
  const problem = check && !check.ok ? nameProblemText(check.problem) : NAME_NOT_ALLOWED

  const ready = value.trim() !== '' && !invalid
  const commit = () => { if (!settled.current) { settled.current = true; onCommit(value) } }
  const cancel = (refocus: boolean) => { if (!settled.current) { settled.current = true; onCancel(refocus) } }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Canvas membajak keyboard (BACKSPACE MENGHAPUS NODE) dan list di atas kita menangani tombol
    // navigasi: semua tombol input ini diklaim di sini.
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); cancel(true) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (ready) commit()
    }
  }

  return (
    <div className="files-input-row nodrag">
      <span className={`codicon codicon-${rename ? (dir ? 'folder' : 'file') : dir ? 'new-folder' : 'new-file'} files-icon`} aria-hidden="true" />
      <Input
        ref={ref}
        className={`files-input${invalid ? ' files-input--invalid' : ''}`}
        value={value}
        placeholder={label}
        aria-label={label}
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (ready && value !== (initial ?? '')) commit(); else cancel(false) }}
      />
      {invalid && <div className="files-input-error" role="alert">{problem}</div>}
    </div>
  )
}
