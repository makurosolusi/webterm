import { useState } from 'react'

interface Props {
  onNewProject: () => void
  onCreateEmpty: (name: string) => void
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"

export default function Welcome({ onNewProject, onCreateEmpty }: Props) {
  const [name, setName] = useState('')

  const createEmpty = () => {
    if (!name.trim()) return
    onCreateEmpty(name.trim())
    setName('')
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#111', color: '#eee', fontFamily: mono, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ color: '#2563eb', fontSize: 28, fontWeight: 600 }}>{'>_'}</span>
        <span style={{ fontSize: 28, fontWeight: 600 }}>webterm</span>
      </div>
      <div style={{ color: '#888', fontSize: 13 }}>A canvas of terminals. Start a project to begin.</div>

      <button
        onClick={onNewProject}
        style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', padding: 16, background: '#181818', border: '1px solid #333', borderRadius: 8, color: '#eee', cursor: 'pointer', fontFamily: mono }}
      >
        <span style={{ fontSize: 15 }}>📁 New project</span>
        <span style={{ color: '#888', fontSize: 12 }}>Pick a folder to start</span>
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#888', fontSize: 12 }}>or create an empty workspace</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ padding: '6px 8px', background: '#1e1e1e', color: '#eee', border: '1px solid #333', borderRadius: 6, fontSize: 13, fontFamily: mono }}
            placeholder="workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createEmpty()}
          />
          <button
            onClick={createEmpty}
            style={{ padding: '6px 10px', background: '#2a2a2a', color: '#eee', border: '1px solid #333', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: mono }}
          >
            Create empty
          </button>
        </div>
      </div>
    </div>
  )
}
