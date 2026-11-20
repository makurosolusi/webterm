import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { sessionLabel } from './sessionList'
import type { ClosedEntry } from './closedHistory'
import { confirmReopen, ReopenConfirmHost } from './reopenConfirm'
import { openWorkspaceCreate } from './workspaceCreate/WorkspaceCreateHost'
import { SetupChecklist } from './Welcome.setup'
import { openSetup } from './setup/setup.open'
import type { SetupState } from '../shared/settings'
import { WELCOME_TEXT } from './workspaceCreate/workspaceCreate.labels'
import './welcome.css'

interface Props {
  onNewProject: () => void
  onCreateEmpty: (name: string) => void
  closedSessions?: ClosedEntry[]
  onReopen?: (id: string) => void
  /** Hydrated setup state; absent (settings still loading) = no setup card, so it never flashes. */
  setup?: SetupState
}

function StartLink({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <li>
      <Button type="button" variant="link" className="welcome__link welcome__link--action" onClick={onClick}>
        <span className={`codicon codicon-${icon}`} aria-hidden />
        <span>{label}</span>
      </Button>
    </li>
  )
}

/** Layar Welcome tanpa workspace: daftar Start (link biru) dan Recently closed, seperti editor Welcome VS Code. */
export default function Welcome({ onNewProject, onCreateEmpty, closedSessions, onReopen, setup }: Props) {
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const closed = closedSessions ?? []
  const nameError = touched && !name.trim() ? WELCOME_TEXT.empty.needName : ''

  const createEmpty = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!name.trim()) return
    onCreateEmpty(name.trim())
    setName('')
    setTouched(false)
  }

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">{WELCOME_TEXT.title}</h1>
        <p className="welcome__subtitle">{WELCOME_TEXT.tagline}</p>

        {setup && <SetupChecklist setup={setup} onOpen={openSetup} />}

        <div className="welcome__columns">
          <section className="welcome__section" aria-labelledby="welcome-start">
            <h2 id="welcome-start" className="welcome__heading">{WELCOME_TEXT.start}</h2>
            <ul className="welcome__list">
              <StartLink icon="new-folder" label={WELCOME_TEXT.newProject} onClick={() => openWorkspaceCreate('project')} />
              <StartLink icon="folder-opened" label={WELCOME_TEXT.openFolder} onClick={() => onNewProject()} />
              <StartLink icon="repo-clone" label={WELCOME_TEXT.cloneRepo} onClick={() => openWorkspaceCreate('clone')} />
            </ul>
            {/* Satu-satunya jalur buat-tanpa-folder webterm: satu form berlabel, bukan placeholder-only. */}
            <form className="welcome__empty" noValidate onSubmit={createEmpty}>
              <Label htmlFor="welcome-workspace-name" className="welcome__empty-label">{WELCOME_TEXT.empty.label}</Label>
              <div className="welcome__empty-row">
                <Input
                  id="welcome-workspace-name"
                  placeholder={WELCOME_TEXT.empty.placeholder}
                  value={name}
                  autoComplete="off"
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? 'welcome-workspace-error' : undefined}
                  onBlur={() => setTouched(true)}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit" variant="outline" className="welcome__empty-submit">{WELCOME_TEXT.empty.submit}</Button>
              </div>
              {nameError && <p id="welcome-workspace-error" className="welcome__empty-error" data-testid="welcome-name-error">{nameError}</p>}
            </form>
          </section>

          {closed.length > 0 && (
            <section className="welcome__section" aria-labelledby="welcome-recent">
              <h2 id="welcome-recent" className="welcome__heading">{WELCOME_TEXT.recent}</h2>
              <ul className="welcome__list">
                {closed.map((e) => (
                  <li key={e.node.id}>
                    <IconTooltip label={e.node.cwd ? `Reopen this session in ${e.node.cwd}` : 'Reopen this session'}>
                      <Button
                        type="button"
                        variant="link"
                        className="welcome__link"
                        // Welcome shows when no workspace is open (`null`), so the reopen always switches.
                        onClick={() => { void confirmReopen(e, null).then((ok) => { if (ok) onReopen?.(e.node.id) }) }}
                      >
                        <span>{sessionLabel(e.node)}</span>
                        <span className="welcome__path">{e.workspaceName}</span>
                      </Button>
                    </IconTooltip>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {/* App.tsx mounts AppHosts (and its ReopenConfirmHost) only while a workspace exists, never
          beside Welcome, so Welcome carries its own host for its closed list. */}
      <ReopenConfirmHost />
    </div>
  )
}
