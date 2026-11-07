// Pemilih folder (modal VS Code): daftar subfolder server-side, naik satu level, lalu pilih.
// "New Folder" meniru panel Open macOS: buat satu folder di folder aktif lalu masuk ke dalamnya.
import { useEffect, useState } from 'react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { IconTooltip } from './components/ui/icon-button'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { listDir, makeFolder, type HttpError } from './api'
import { folderNameError } from '../shared/folderName'
import './folderPicker.css'

interface Props {
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}

/** Gabung folder + anak tanpa menggandakan `/` (akar `/` dan path ber-trailing slash). */
export function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`
}

export default function FolderPicker({ initialPath, onPick, onClose }: Props) {
  const [path, setPath] = useState(initialPath ?? '')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Keep the last good listing on failure (a 404 just means "don't go there"), but say so.
  const load = (p?: string) => {
    listDir(p)
      .then((r) => {
        setPath(r.path)
        setParent(r.parent)
        setDirs(r.dirs)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(`Cannot open ${p ?? 'the folder'}: ${err instanceof Error ? err.message : 'request failed'}`)
      })
  }
  useEffect(() => { load(initialPath) }, [])

  // null = no inline "new folder" row; otherwise the name being typed.
  const [newName, setNewName] = useState<string | null>(null)
  const [newError, setNewError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const cancelNew = () => { setNewName(null); setNewError(null) }
  const createNew = () => {
    if (newName === null || creating) return
    const invalid = folderNameError(newName)
    if (invalid) { setNewError(invalid); return }
    setCreating(true)
    setNewError(null)
    makeFolder(path, newName)
      .then((r) => { cancelNew(); load(r.path) })
      .catch((err: unknown) => {
        const e = err as Partial<HttpError>
        setNewError(e.serverMessage ?? `Cannot create "${newName}": ${e.message ?? 'request failed'}`)
      })
      .finally(() => setCreating(false))
  }

  const select = (
    <button key="select" type="button" className="fp-button fp-button--primary" onClick={() => onPick(path)}>
      Select this folder
    </button>
  )
  const cancel = (
    <button key="cancel" type="button" className="fp-button" onClick={onClose}>
      Cancel
    </button>
  )

  return (
    <VscodeDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Choose a folder"
      width={480}
      className="folder-picker"
      footer={arrangeDialogButtons([select, cancel], 1)}
    >
      <div className="fp-bar">
        <IconTooltip label={parent ? `Go up to ${parent}` : 'Go up to the parent folder'} disabled={parent === null} disabledReason="already at the top folder">
          <button
            type="button"
            className="fp-up"
            aria-label="Go up"
            onClick={() => parent && load(parent)}
            disabled={parent === null}
          >
            <span className="codicon codicon-arrow-up" aria-hidden />
          </button>
        </IconTooltip>
        <span className="fp-path" title={path}>{path}</span>
        <IconTooltip label="New Folder" disabled={!path} disabledReason="no folder open">
          <button
            type="button"
            className="fp-up"
            aria-label="New Folder"
            onClick={() => { setNewName(''); setNewError(null) }}
            disabled={!path}
          >
            <span className="codicon codicon-new-folder" aria-hidden />
          </button>
        </IconTooltip>
      </div>
      {error && <div className="fp-error" role="alert">{error}</div>}
      <div className="fp-list" role="list">
        {newName !== null && (
          <div className="fp-row fp-new" role="listitem">
            <span className="codicon codicon-folder" aria-hidden />
            <input
              className="fp-new__input"
              aria-label="New folder name"
              aria-invalid={newError !== null}
              autoFocus
              value={newName}
              disabled={creating}
              onChange={(e) => { setNewName(e.target.value); setNewError(null) }}
              onBlur={() => { if (newName === '' && !creating) cancelNew() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); createNew() }
                // Escape closes the row only; stopPropagation keeps the dialog open.
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelNew() }
              }}
            />
            {creating && <span className="fp-new__status">Creating…</span>}
          </div>
        )}
        {newError && <div className="fp-error fp-new__error" role="alert">{newError}</div>}
        {dirs.length === 0 && newName === null && <span className="fp-empty">No subfolders</span>}
        {dirs.map((d) => (
          <button key={d} type="button" className="fp-row" role="listitem" onClick={() => load(joinPath(path, d))}>
            <span className="codicon codicon-folder" aria-hidden />
            <span className="fp-row__name">{d}</span>
          </button>
        ))}
      </div>
    </VscodeDialog>
  )
}
