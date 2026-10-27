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
      <div style={{ width: 520, maxHeight: '70vh', background: '#181818', border: '1px solid #333', borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, borderBottom: '1px solid #333' }}>
          <button
            onClick={() => parent && load(parent)}
            disabled={parent === null}
            style={{ background: '#2a2a2a', color: '#eee', border: '1px solid #3a3a3a', borderRadius: 4, padding: '4px 8px', cursor: parent === null ? 'default' : 'pointer', opacity: parent === null ? 0.4 : 1, fontSize: 12 }}
          >
            ⬆ up
          </button>
          <span style={{ flex: 1, color: '#ccc', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{path}</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {dirs.length === 0 && <span style={{ color: '#666', fontSize: 12, padding: 6 }}>(no subfolders)</span>}
          {dirs.map((d) => (
            <button
              key={d}
              onClick={() => load(path + '/' + d)}
              style={{ textAlign: 'left', background: 'transparent', color: '#eee', border: 'none', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', fontSize: 13, fontFamily: 'monospace' }}
            >
              📁 {d}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 10, borderTop: '1px solid #333' }}>
          <button onClick={onClose} style={{ background: '#2a2a2a', color: '#eee', border: '1px solid #3a3a3a', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={() => onPick(path)} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Select this folder</button>
        </div>
      </div>
    </div>
  )
}
