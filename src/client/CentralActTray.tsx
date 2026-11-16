// The one notice for "Central just acted": the latest action (merged), a Show button and "N more".
// It never moves the camera: Show / Open are user clicks. The polite live region is always mounted and
// speaks at most once per ANNOUNCE_GAP_MS, so a burst of actions is read as one sentence, never assertively.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import type { ActEntry } from './centralAct.store'
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
export function actSentence(e: ActEntry, t: Target): string {
  if (t.kind === 'closed') return 'Node closed'
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

export function CentralActTray(props: CentralActTrayProps): React.JSX.Element {
  const latest = props.entries[0]
  const target = latest ? targetOf(latest, props) : null
  const sentence = latest && target ? actSentence(latest, target) : ''
  const more = Math.max(0, props.entries.length - 1) + props.dropped
  const spoken = useThrottledText(sentence, ANNOUNCE_GAP_MS)
  return (
    <div className="central-act-tray" data-state={latest ? 'active' : 'idle'}>
      <span className="central-act-tray__live" role="status" aria-live="polite" aria-atomic="true">{spoken}</span>
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
        </div>
      )}
    </div>
  )
}
