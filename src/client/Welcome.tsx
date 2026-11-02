import { useState } from 'react'
import { FolderPlus, Folder, GitBranch, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import Brand from './Brand'
import { sessionLabel } from './sessionList'
import type { ClosedEntry } from './closedHistory'

interface Props {
  onNewProject: () => void
  onCreateEmpty: (name: string) => void
  closedSessions?: ClosedEntry[]
  onReopen?: (id: string) => void
}

// Ukuran ikon kartu. Kelas `size-[22px]` wajib ada: utility `[&_svg:not([class*='size-'])]:size-4`
// milik Button akan mengecilkan ikon 22px jadi 16px kalau SVG-nya tak membawa kelas ukuran sendiri.
const ICON_CLASS = 'size-[22px]'

function ActionTile({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      // `disabled:pointer-events-auto`: tooltip "Not available in webterm yet" ada di `title`, dan
      // `disabled:pointer-events-none` bawaan Button mematikan hover pada kartu yang disabled.
      // `disabled:hover:bg-card` menjaga kartu disabled tidak ikut menyala saat di-hover.
      className="h-[92px] w-[150px] flex-col gap-2.5 rounded-xl border-border bg-card p-0 text-[13px] text-foreground shadow-none hover:bg-accent disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-card"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title={disabled ? 'Not available in webterm yet' : undefined}
    >
      <span aria-hidden className="flex">{icon}</span>
      <span>{label}</span>
    </Button>
  )
}

export default function Welcome({ onNewProject, onCreateEmpty, closedSessions, onReopen }: Props) {
  const [name, setName] = useState('')
  const closed = closedSessions ?? []

  const createEmpty = () => {
    if (!name.trim()) return
    onCreateEmpty(name.trim())
    setName('')
  }

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 overflow-auto bg-[var(--canvas-bg)] px-4 py-6 text-foreground">
      <Brand gradientId="wt-brand" labelClassName="text-foreground" />
      <div className="mt-1 mb-7 text-[13px] text-muted-foreground">
        A canvas of terminals. Start a project to begin.
      </div>

      <div className="flex flex-wrap justify-center gap-3.5">
        <ActionTile icon={<FolderPlus className={ICON_CLASS} />} label="New project" onClick={onNewProject} />
        <ActionTile icon={<Folder className={ICON_CLASS} />} label="Open folder…" onClick={onNewProject} />
        <ActionTile icon={<GitBranch className={ICON_CLASS} />} label="Clone repo…" disabled />
        <ActionTile icon={<Server className={ICON_CLASS} />} label="Connect over SSH…" disabled />
      </div>

      {/* Satu-satunya jalur buat-tanpa-folder webterm; dibiarkan sebagai baris sekunder tipis. */}
      <div className="mt-3.5 flex items-center gap-2">
        <Label htmlFor="welcome-workspace-name" className="text-xs font-normal text-muted-foreground">
          or create an empty workspace
        </Label>
        <Input
          id="welcome-workspace-name"
          className="h-auto focus-visible:ring-0"
          placeholder="workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createEmpty()}
        />
        <Button type="button" variant="ghost" className="h-auto" onClick={createEmpty}>Create empty</Button>
      </div>

      {/* Lebar bingkai = deretan empat kartu di atasnya: 4 x 150px + 3 x 14px. */}
      {closed.length > 0 && (
        <div className="mt-7 grid w-full max-w-[642px] grid-cols-2 gap-x-3.5 gap-y-7">
          <div>
            <div className="mb-2 text-[11px] tracking-[0.04em] text-muted-foreground uppercase">
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
                className="flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2"
              >
                <span className="text-[13px]">{sessionLabel(e.node)}</span>
                <span className="text-[11px] text-muted-foreground">{e.workspaceName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
