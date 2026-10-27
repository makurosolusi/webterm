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
    <div style={{ position: 'absolute', inset: 0, background: 'var(--canvas-bg)', color: 'var(--text)', fontFamily: mono, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ color: 'var(--accent)', fontSize: 28, fontWeight: 600 }}>{'>_'}</span>
        <span style={{ fontSize: 28, fontWeight: 600 }}>webterm</span>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>A canvas of terminals. Start a project to begin.</div>

      <button
        onClick={onNewProject}
        style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left', padding: 16, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', cursor: 'pointer', fontFamily: mono }}
      >
        <span style={{ fontSize: 15 }}>📁 New project</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>Pick a folder to start</span>
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>or create an empty workspace</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="field"
            style={{ fontFamily: mono }}
            placeholder="workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createEmpty()}
          />
          <button className="btn btn--ghost" onClick={createEmpty}>
            Create empty
          </button>
        </div>
      </div>
    </div>
  )
}
