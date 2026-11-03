// Input nama inline untuk "New File…/New Folder…" (pengganti `window.prompt`). Enter memasang,
// Escape/blur membatalkan, nama tak valid ditandai langsung dan Enter tidak melakukan apa pun.
import { useEffect, useRef, useState } from 'react'
import { newEntryPath } from './fileBrowse'
import { NAME_NOT_ALLOWED } from './filesCreate'

interface Props {
  dir: boolean
  /** Folder tempat entri dibuat; dipakai validasi dan label. */
  base: string
  onCommit: (name: string) => void
  /** `refocus`: true bila dibatalkan lewat Escape (fokus kembali ke daftar); false saat blur. */
  onCancel: (refocus: boolean) => void
}

export default function FilesInput({ dir, base, onCommit, onCancel }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const invalid = value.trim() !== '' && newEntryPath(base, value) === null
  const label = dir ? 'New folder name' : 'New file name'

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Canvas membajak keyboard (BACKSPACE MENGHAPUS NODE) dan list di atas kita menangani tombol
    // navigasi: semua tombol input ini diklaim di sini.
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); onCancel(true) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (value.trim() !== '' && !invalid) onCommit(value)
    }
  }

  return (
    <div className="files-input-row nodrag">
      <span className={`codicon codicon-${dir ? 'new-folder' : 'new-file'} files-icon`} aria-hidden="true" />
      <input
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
        onBlur={() => onCancel(false)}
      />
      {invalid && <div className="files-input-error" role="alert">{NAME_NOT_ALLOWED}</div>}
    </div>
  )
}
