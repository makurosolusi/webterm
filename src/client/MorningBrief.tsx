// Morning brief card (PLAN F3-e): what happened while you were away, served from the server's
// cached deterministic brief (src/server/brief). Shown once per visit when the app opens; Dismiss
// is persisted server-side. ⌘K "Brief: Show morning brief" brings it back. Each line is a link:
// focus the node, open the Inbox, or open a Diff node for the workspace. Optional (F5-c): an AI paragraph
// over the lines (off by default, server-checked against their counts) and "Continue from yesterday".
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BRIEF_CATEGORIES, briefHeading, type BriefLine, type BriefTarget } from '../server/brief/brief.model'
import type { BriefResponse } from '../server/brief/brief.service'
import type { BriefNarrative } from '../server/brief/brief.narrative'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { useRegisterCommands, type Command } from './commandRegistry'
import { request } from './inboxTransport'
import { ContinueSection, useContinue } from './MorningBriefContinue'
import { MorningBriefLlmToggle } from './MorningBriefSettings'
import './MorningBrief.css'

export const BRIEF_PATH = '/api/brief'

export interface MorningBriefProps {
  onFocusNode: (nodeId: string) => void
  onOpenInbox: () => void
  onOpenDiff: (workspaceId: string) => void
  /** Opens a workspace after "Continue from yesterday" so its agents resume. */
  onOpenWorkspace?: (workspaceId: string) => void
}

const sinceText = (ts: number): string =>
  new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Runs a line's click target; exported for the click-target tests. */
export function openTarget(target: BriefTarget, props: MorningBriefProps): void {
  if (!target) return
  if (target.kind === 'node') props.onFocusNode(target.nodeId)
  else if (target.kind === 'inbox') props.onOpenInbox()
  else props.onOpenDiff(target.workspaceId)
}

export default function MorningBrief(props: MorningBriefProps): React.JSX.Element | null {
  const [brief, setBrief] = useState<BriefResponse | null>(null)
  const [forced, setForced] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [narrative, setNarrative] = useState<string | null>(null)
  const resume = useContinue(props.onOpenWorkspace)

  const load = useCallback((): void => {
    request<BriefResponse>(BRIEF_PATH).then(setBrief, (err: unknown) => {
      // 503 ledger_off / offline: no card is the right answer, the board still works.
      console.warn('[brief] GET /api/brief failed', err)
    })
  }, [])
  useEffect(load, [load])
  const llm = brief?.llm === true
  const key = brief ? `${brief.since}:${brief.headSeq}` : ''
  useEffect(() => {
    setNarrative(null)
    if (!llm) return
    request<BriefNarrative>(`${BRIEF_PATH}/narrative`).then((r) => setNarrative(r.narrative), (err: unknown) => {
      console.warn('[brief] GET /api/brief/narrative failed', err) // the lines are the brief; the paragraph is optional
    })
  }, [llm, key])

  const commands = useMemo<Command[]>(() => [{
    id: 'brief.show', label: 'Brief: Show morning brief', run: () => { setForced(true); setHidden(false); load() },
  }], [load])
  useRegisterCommands(commands)

  if (!brief || hidden) return null
  if (!forced && (brief.dismissed || (brief.lines.length === 0 && resume.workspaces.length === 0))) return null

  const close = (): void => {
    setHidden(true)
    setForced(false)
    if (brief.dismissed) return
    request<BriefResponse>(`${BRIEF_PATH}/dismiss`, { method: 'POST' }).then(setBrief, (err: unknown) => {
      console.warn('[brief] POST /api/brief/dismiss failed', err)
    })
  }
  const click = (line: BriefLine): void => openTarget(line.target, props)

  return (
    <section className="morning-brief" role="dialog" aria-label="Morning brief">
      <header className="morning-brief__head">
        <strong>Morning brief</strong>
        <span className="morning-brief__since">since {sinceText(brief.since)}</span>
        <IconButton size="icon-xs" className="morning-brief__close" onClick={close} label="Dismiss morning brief">×</IconButton>
      </header>
      {narrative && <p className="morning-brief__narrative" data-testid="brief-narrative">{narrative}</p>}
      {brief.lines.length === 0 && <p className="morning-brief__empty">Nothing new since you were last here.</p>}
      {BRIEF_CATEGORIES.map((c) => {
        const group = brief.lines.filter((l) => l.category === c)
        if (group.length === 0) return null
        return (
          <div key={c} className="morning-brief__group" data-category={c}>
            <h4>{briefHeading(c)}</h4>
            <ul>
              {group.map((l) => (
                <li key={l.id}>
                  {l.target ? <Button variant="link" size="xs" className="morning-brief__link" onClick={() => click(l)}>{l.text}</Button> : <span>{l.text}</span>}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      <ContinueSection {...resume} />
      <footer className="morning-brief__foot">
        <MorningBriefLlmToggle on={brief.llm} onChange={setBrief} />
      </footer>
    </section>
  )
}
