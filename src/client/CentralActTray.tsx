// The one notice for "Central just acted": the latest action (merged), a Show button and "N more".
// It never moves the camera itself: Show / Open are user clicks; Follow (centralFollow.ts) is switched here. The polite live region is always mounted and
// speaks at most once per ANNOUNCE_GAP_MS, so a burst of actions is read as one sentence, never assertively.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import type { ActEntry } from './centralAct.store'
import type { FollowView } from './centralFollow'
import './centralAct.css'

/** Shortest gap between two screen-reader announcements. */
export const ANNOUNCE_GAP_MS = 3000

export interface CentralActTrayProps {
  entries: readonly ActEntry[]
  /** Nodes evicted from the store; they count toward "N more". */
  dropped: number
  activeWorkspaceId: string | null
  /** Title of a node on the open board; undefined when the board has no such node. */
  nodeTitle(nodeId: string): string | undefined
  /** Name of a board, once known. */
  boardName(workspaceId: string): string | undefined
  follow: FollowView
  onToggleFollow(): void
  onShow(nodeId: string): void
  onOpenBoard(workspaceId: string): void
}

type Target = { kind: 'here'; title: string } | { kind: 'board'; workspaceId: string; name: string } | { kind: 'closed' }

function targetOf(e: ActEntry, p: CentralActTrayProps): Target {
  const title = p.nodeTitle(e.nodeId)
  if (title !== undefined) return { kind: 'here', title }
  if (e.workspaceId && e.workspaceId !== p.activeWorkspaceId) return { kind: 'board', workspaceId: e.workspaceId, name: p.boardName(e.workspaceId) ?? 'another board' }
  return { kind: 'closed' }
}

/** What the notice says; also what the live region speaks. */
export function actSentence(e: ActEntry, t: Target, held = false): string {
  if (t.kind === 'closed') return 'Node closed'
  if (held && t.kind === 'here') return `Central acted on ${t.title}`
  const count = e.n > 1 ? ` (${e.n} actions)` : ''
  return t.kind === 'here' ? `Central ${e.verb} ${t.title}${count}` : `Central ${e.verb} a node in ${t.name}${count}`
}

/** `text` held back so it changes at most once per `gapMs`; clearing it is immediate and spends nothing. */
function useThrottledText(text: string, gapMs: number): string {
  const [shown, setShown] = useState('')
  const last = useRef(0)
  useEffect(() => {
    if (text === '') { setShown(''); return }
    const wait = last.current + gapMs - Date.now()
    if (wait <= 0) { last.current = Date.now(); setShown(text); return }
    const t = setTimeout(() => { last.current = Date.now(); setShown(text) }, wait)
    return () => clearTimeout(t)
  }, [text, gapMs])
  return shown
}

/** Switch label; also the tooltip. The countdown is visual only (never spoken). */
export function followLabel(f: FollowView): string {
  if (f.status === 'off') return 'Follow off'
  if (f.status === 'paused') return `Paused (you moved the canvas) · resumes in ${f.resumeInS}s`
  return f.more > 0 ? `Following Central · ${f.more} more` : 'Following Central'
}
/** What the live region says about Follow: no countdown, so it changes only when the status does. */
const followSpoken = (f: FollowView): string => (f.status === 'off' ? 'Follow off' : f.status === 'paused' ? 'Follow paused' : 'Following Central')

function FollowSwitch({ follow, onToggle }: { follow: FollowView; onToggle(): void }): React.JSX.Element {
  const tip = follow.on ? `${followLabel(follow)} — click to turn off` : 'Follow off — click to let the camera follow Central'
  return (
    <IconTooltip label={tip}>
      <Button type="button" variant="ghost" size="xs" className="central-act-tray__btn central-act-tray__follow" aria-pressed={follow.on} data-follow={follow.status} onClick={onToggle}>
        <span className={`codicon ${follow.on ? 'codicon-eye' : 'codicon-eye-closed'}`} aria-hidden="true" />
        {followLabel(follow)}
      </Button>
    </IconTooltip>
  )
}

export function CentralActTray(props: CentralActTrayProps): React.JSX.Element {
  const latest = props.entries[0]
  const target = latest ? targetOf(latest, props) : null
  const held = props.follow.status === 'held'
  const sentence = latest && target ? actSentence(latest, target, held) : ''
  const more = Math.max(0, props.entries.length - 1) + props.dropped
  const spoken = useThrottledText(sentence, ANNOUNCE_GAP_MS)
  const spokenFollow = useThrottledText(latest || !props.follow.on ? followSpoken(props.follow) : '', ANNOUNCE_GAP_MS)
  return (
    <div className="central-act-tray" data-state={latest || !props.follow.on ? 'active' : 'idle'}>
      <span className="central-act-tray__live" role="status" aria-live="polite" aria-atomic="true">{spoken}</span>
      <span className="central-act-tray__live central-act-tray__live--follow" aria-live="polite" aria-atomic="true">{spokenFollow}</span>
      {latest && target && (
        <div className="central-act-tray__row" data-target={target.kind}>
          <span className="codicon codicon-sparkle" aria-hidden="true" />
          <span className="central-act-tray__text" aria-hidden="true">{sentence}</span>
          {more > 0 && <span className="central-act-tray__more" aria-hidden="true">{`${more} more`}</span>}
          {target.kind === 'here' && (
            <IconTooltip label="Bring this node into view"><Button type="button" variant="ghost" size="xs" className="central-act-tray__btn" onClick={() => props.onShow(latest.nodeId)}>Show</Button></IconTooltip>
          )}
          {target.kind === 'board' && (
            <IconTooltip label={`Switch to ${target.name}`}><Button type="button" variant="ghost" size="xs" className="central-act-tray__btn" onClick={() => props.onOpenBoard(target.workspaceId)}>Open</Button></IconTooltip>
          )}
          {target.kind === 'closed' && <Button type="button" variant="ghost" size="xs" className="central-act-tray__btn" disabled>Show</Button>}
          <FollowSwitch follow={props.follow} onToggle={props.onToggleFollow} />
        </div>
      )}
      {!latest && !props.follow.on && (
        <div className="central-act-tray__row"><FollowSwitch follow={props.follow} onToggle={props.onToggleFollow} /></div>
      )}
    </div>
  )
}
