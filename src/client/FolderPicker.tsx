// Pemilih folder (modal VS Code): daftar subfolder server-side, naik satu level, lalu pilih.
import { useEffect, useState } from 'react'
import { VscodeDialog } from './components/vscode/vscodeDialog'
import { arrangeDialogButtons } from './components/vscode/vscodeDialogButtons'
import { listDir } from './api'
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
        <button
          type="button"
          className="fp-up"
          aria-label="Go up"
          title="Go up"
          onClick={() => parent && load(parent)}
          disabled={parent === null}
        >
          <span className="codicon codicon-arrow-up" aria-hidden />
        </button>
        <span className="fp-path" title={path}>{path}</span>
      </div>
      {error && <div className="fp-error" role="alert">{error}</div>}
      <div className="fp-list" role="list">
        {dirs.length === 0 && <span className="fp-empty">No subfolders</span>}
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
