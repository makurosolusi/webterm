import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { sessionLabel } from './sessionList'
import type { ClosedEntry } from './closedHistory'
import './welcome.css'

interface Props {
  onNewProject: () => void
  onCreateEmpty: (name: string) => void
  closedSessions?: ClosedEntry[]
  onReopen?: (id: string) => void
}

function StartLink({ icon, label, onClick, disabled }: { icon: string; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <li>
      <Button
        type="button"
        variant="link"
        className="welcome__link"
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        title={disabled ? 'Not available in webterm yet' : undefined}
      >
        <span className={`codicon codicon-${icon}`} aria-hidden />
        <span>{label}</span>
      </Button>
    </li>
  )
}

/** Layar Welcome tanpa workspace: daftar Start (link biru) dan Recently closed, seperti editor Welcome VS Code. */
export default function Welcome({ onNewProject, onCreateEmpty, closedSessions, onReopen }: Props) {
  const [name, setName] = useState('')
  const closed = closedSessions ?? []

  const createEmpty = () => {
    if (!name.trim()) return
    onCreateEmpty(name.trim())
    setName('')
  }

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">webterm</h1>
        <div className="welcome__subtitle">A canvas of terminals. Start a project to begin.</div>

        <div className="welcome__columns">
          <section className="welcome__section" aria-labelledby="welcome-start">
            <h2 id="welcome-start" className="welcome__heading">Start</h2>
            <ul className="welcome__list">
              <StartLink icon="new-folder" label="New project" onClick={onNewProject} />
              <StartLink icon="folder-opened" label="Open folder…" onClick={onNewProject} />
              <StartLink icon="repo-clone" label="Clone repo…" disabled />
              <StartLink icon="remote" label="Connect over SSH…" disabled />
            </ul>
            {/* Satu-satunya jalur buat-tanpa-folder webterm; dibiarkan sebagai baris sekunder tipis. */}
            <div className="welcome__empty">
              <Label htmlFor="welcome-workspace-name" className="text-xs font-normal">
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
          </section>

          {closed.length > 0 && (
            <section className="welcome__section" aria-labelledby="welcome-recent">
              <h2 id="welcome-recent" className="welcome__heading">Recently closed</h2>
              <ul className="welcome__list">
                {closed.map((e) => (
                  <li key={e.node.id}>
                    <Button
                      type="button"
                      variant="link"
                      className="welcome__link"
                      title={e.node.cwd ?? ''}
                      onClick={() => onReopen?.(e.node.id)}
                    >
                      <span>{sessionLabel(e.node)}</span>
                      <span className="welcome__path">{e.workspaceName}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
