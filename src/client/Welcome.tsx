import { useState } from 'react'
import { FolderPlus, Folder, GitBranch, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { sessionLabel } from './sessionList'
import type { ClosedEntry } from './closedHistory'

interface Props {
  onNewProject: () => void
  onCreateEmpty: (name: string) => void
  closedSessions?: ClosedEntry[]
  onReopen?: (id: string) => void
}

const CARD_W = 150
const CARD_GAP = 14
// Ukuran ikon kartu. Ditulis eksplisit: utility `[&_svg]:size-4` milik Button akan mengecilkan
// ikon 22px jadi 16px kalau SVG-nya tak punya ukuran inline sendiri.
const ICON_SIZE = 22
// Lebar bingkai daftar = sejajar dengan deretan empat kartu di atasnya.
const LISTS_W = `calc(${4 * CARD_W}px + ${3 * CARD_GAP}px)`

// Brand chevron nodeterm (porting: 40x40, gradien ungu). Tak ada file aset — satu SVG inline lebih
// murah daripada menambah dependency atau file gambar untuk satu logo.
function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={40} height={40} viewBox="0 0 48 48" aria-hidden>
        <defs>
          <linearGradient id="wt-brand" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a38dff" />
            <stop offset="1" stopColor="#622994" />
          </linearGradient>
        </defs>
        <path d="M13 12 L31 24 L13 36" fill="none" stroke="url(#wt-brand)" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={13} cy={12} r={3.6} fill="#a38dff" />
        <circle cx={13} cy={36} r={3.6} fill="#a38dff" />
        <circle cx={31} cy={24} r={3.6} fill="#fff" />
        <rect x={33.5} y={32.5} width={10.5} height={5} rx={2.5} fill="#a38dff" />
      </svg>
      <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5, color: 'var(--text)' }}>webterm</span>
    </div>
  )
}

const cardBase: React.CSSProperties = {
  width: CARD_W,
  height: 92,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  color: 'var(--text)',
  fontSize: 13,
}

function ActionTile({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      // `disabled:pointer-events-auto`: tooltip "Not available in webterm yet" ada di `title`, dan
      // `disabled:pointer-events-none` bawaan Button mematikan hover pada kartu yang disabled.
      className="h-auto p-0 shadow-none disabled:pointer-events-auto"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title={disabled ? 'Not available in webterm yet' : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...cardBase,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: !disabled && hover ? 'var(--panel-header)' : 'var(--panel)',
      }}
    >
      <span aria-hidden style={{ display: 'flex' }}>{icon}</span>
      <span>{label}</span>
    </Button>
  )
}

export default function Welcome({ onNewProject, onCreateEmpty, closedSessions, onReopen }: Props) {
  const [name, setName] = useState('')

  const createEmpty = () => {
    if (!name.trim()) return
    onCreateEmpty(name.trim())
    setName('')
  }

  const closed = closedSessions ?? []

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'auto',
        background: 'var(--canvas-bg)',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '24px 16px',
      }}
    >
      <Brand />
      <div style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 28px' }}>
        A canvas of terminals. Start a project to begin.
      </div>

      <div style={{ display: 'flex', gap: CARD_GAP, flexWrap: 'wrap', justifyContent: 'center' }}>
        <ActionTile icon={<FolderPlus size={ICON_SIZE} style={{ width: ICON_SIZE, height: ICON_SIZE }} />} label="New project" onClick={onNewProject} />
        <ActionTile icon={<Folder size={ICON_SIZE} style={{ width: ICON_SIZE, height: ICON_SIZE }} />} label="Open folder…" onClick={onNewProject} />
        <ActionTile icon={<GitBranch size={ICON_SIZE} style={{ width: ICON_SIZE, height: ICON_SIZE }} />} label="Clone repo…" disabled />
        <ActionTile icon={<Server size={ICON_SIZE} style={{ width: ICON_SIZE, height: ICON_SIZE }} />} label="Connect over SSH…" disabled />
      </div>

      {/* Satu-satunya jalur buat-tanpa-folder webterm; dibiarkan sebagai baris sekunder tipis. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        <Label htmlFor="welcome-workspace-name" style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 400 }}>
          or create an empty workspace
        </Label>
        <Input
          id="welcome-workspace-name"
          className="field h-auto focus-visible:ring-0"
          placeholder="workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createEmpty()}
        />
        <Button type="button" variant="ghost" className="btn btn--ghost h-auto" onClick={createEmpty}>Create empty</Button>
      </div>

      {closed.length > 0 && (
        <div style={{ width: '100%', maxWidth: LISTS_W, display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: CARD_GAP, rowGap: 28, marginTop: 28 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 8 }}>
              Recently closed
            </div>
            {closed.map((e) => (
              <div
                key={e.node.id}
                role="button"
                tabIndex={0}
                title={e.node.cwd ?? ''}
                onClick={() => onReopen?.(e.node.id)}
                onKeyDown={(ev) => {
                  if (ev.key !== 'Enter' && ev.key !== ' ') return
                  ev.preventDefault()
                  onReopen?.(e.node.id)
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}
              >
                <span style={{ fontSize: 13 }}>{sessionLabel(e.node)}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{e.workspaceName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
