import { useEffect, useState } from 'react'
import { listDir } from './api'

interface Props {
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}

export default function FolderPicker({ initialPath, onPick, onClose }: Props) {
  const [path, setPath] = useState(initialPath ?? '')
  const [parent, setParent] = useState<string | null>(null)
  const [dirs, setDirs] = useState<string[]>([])

  // Keep the last good listing on failure (a 404 just means "don't go there").
  const load = (p?: string) => {
    listDir(p).then((r) => { setPath(r.path); setParent(r.parent); setDirs(r.dirs) }).catch(() => {})
  }
  useEffect(() => { load(initialPath) }, [])

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="panel" style={{ width: 520, maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, borderBottom: '1px solid var(--border)' }}>
          <button
            className="btn btn--ghost"
            onClick={() => parent && load(parent)}
            disabled={parent === null}
            style={{ cursor: parent === null ? 'default' : 'pointer', opacity: parent === null ? 0.4 : 1 }}
          >
            ⬆ up
          </button>
          <span style={{ flex: 1, color: 'var(--muted)', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{path}</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {dirs.length === 0 && <span style={{ color: 'var(--muted)', fontSize: 12, padding: 6 }}>(no subfolders)</span>}
          {dirs.map((d) => (
            <button
              key={d}
              onClick={() => load(path + '/' + d)}
              style={{ textAlign: 'left', background: 'transparent', color: 'var(--text)', border: 'none', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 13, fontFamily: 'monospace' }}
            >
              📁 {d}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 10, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--accent" onClick={() => onPick(path)}>Select this folder</button>
        </div>
      </div>
    </div>
  )
}
