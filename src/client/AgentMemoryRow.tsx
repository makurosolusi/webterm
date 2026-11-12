// One row of "What agents remember" (AgentMemory.tsx), shaped like ChatGPT's memory manager / Cursor's rules list:
// the text, an Edit icon shown on hover or keyboard focus, and a "⋯" menu holding Mute and Forget (destructive,
// asks first). Badges show only the exceptions (suggested, from a web page, still true?, muted); confirmed is the
// default and gets none. Confirm stays a visible button, since it is what a suggestion waits for.
import { useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult } from '@/components/ui/action'
import { portalContainer } from '@/components/vscode/portalContainer'
import { MEMORY_BUSY, MemoryButton, useMemoryAction } from './AgentMemoryBoard'
import { ctl, MEMORY_TEXT, PROCEDURAL_PATH, type MemoryItem } from './AgentMemory.api'
import './agentChat/agentChatToolbar.css'
import './agentMemory.css'

export type RowAct = (what: string, path: string, body?: unknown) => Promise<void>

/** Badges for what is unusual about `m`; a confirmed, active memory has none. */
export function memoryBadges(m: MemoryItem): string[] {
  const out: string[] = []
  if (m.trust === 'external') out.push(MEMORY_TEXT.untrusted)
  else if (m.status === 'claim') out.push(MEMORY_TEXT.suggested)
  if (m.needsReview) out.push(MEMORY_TEXT.review)
  if (m.suppressed) out.push(MEMORY_TEXT.muted)
  return out
}

export function MemoryRow({ m, confirmable, act }: { m: MemoryItem; confirmable: boolean; act: RowAct }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // Forget cannot be undone (the server has no restore), so it asks first, like Central's own memory list.
  const [asking, setAsking] = useState(false)
  const untrusted = m.trust === 'external'
  // A claim is confirmed (procedural route); a fact that went stale is confirmed again (verify).
  const confirmPath = m.status === 'claim'
    ? (confirmable ? `${PROCEDURAL_PATH}/${encodeURIComponent(m.id)}/confirm` : null)
    : (m.needsReview ? ctl(m.id, 'verify') : null)
  // Menu items and Save unmount on click, so their results live on the row.
  const forget = useMemoryAction(MEMORY_TEXT.forget, () => act(MEMORY_TEXT.forget, ctl(m.id, 'forget')))
  const mute = useMemoryAction(MEMORY_TEXT.mute, () => act(MEMORY_TEXT.mute, ctl(m.id, 'suppress'), { on: !m.suppressed }))
  const save = useMemoryAction(MEMORY_TEXT.edit, async () => { await act(MEMORY_TEXT.edit, ctl(m.id, 'edit'), { text: (draft ?? '').trim() }); setDraft(null) })
  const badges = memoryBadges(m)
  return (
    <li data-memory={m.id} data-kind={m.kind} className="memory-row flex flex-col gap-1 border-b border-(--vscode-panel-border) py-1">
      <div className="flex items-start gap-1">
        {draft === null
          ? <span className={`min-w-0 flex-1 break-words [overflow-wrap:anywhere] ${m.suppressed ? 'opacity-60' : ''}`}>{m.text}</span>
          : <Input aria-label={MEMORY_TEXT.edit} value={draft} maxLength={1200} onChange={(e) => setDraft(e.target.value)} className="w-full min-w-0 flex-1" />}
        {draft === null ? (
          <span data-slot="memory-row-actions" className="flex flex-none items-center">
            {!untrusted ? (
              <span className="memory-row__reveal">
                <IconButton label={MEMORY_TEXT.edit} size="icon-sm" onClick={() => setDraft(m.text)}><span className="codicon codicon-edit" aria-hidden="true" /></IconButton>
              </span>
            ) : null}
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <IconButton label={MEMORY_TEXT.more} size="icon-sm"><span className="codicon codicon-ellipsis" aria-hidden="true" /></IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal container={portalContainer()}>
                <DropdownMenu.Content className="act-menu" align="end" sideOffset={4}>
                  <DropdownMenu.Item className="act-menu__item" onSelect={() => void mute.run()}>{m.suppressed ? MEMORY_TEXT.unmute : MEMORY_TEXT.mute}</DropdownMenu.Item>
                  <DropdownMenu.Separator className="act-menu__separator" />
                  <DropdownMenu.Item className="act-menu__item act-menu__item--danger" onSelect={() => setAsking(true)}>{MEMORY_TEXT.forget}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </span>
        ) : null}
      </div>
      {badges.length > 0 || confirmPath || asking || draft !== null ? (
        <div data-slot="memory-row-meta" className="flex flex-wrap items-center gap-1">
          {badges.map((b) => <Badge key={b} variant="outline">{b}</Badge>)}
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {draft !== null ? (
              <>
                <ActionButton size="sm" disabled={draft.trim() === ''} action={save} busyLabel={MEMORY_BUSY.save}>{MEMORY_TEXT.save}</ActionButton>
                <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{MEMORY_TEXT.cancel}</Button>
              </>
            ) : asking ? (
              <span role="alertdialog" aria-label={MEMORY_TEXT.forgetAsk} className="flex flex-wrap items-center gap-1">
                <span>{MEMORY_TEXT.forgetAsk}</span>
                <ActionButton size="sm" variant="destructive" action={forget} busyLabel={MEMORY_BUSY.forget} onClick={() => setAsking(false)}>{MEMORY_TEXT.forget}</ActionButton>
                <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>{MEMORY_TEXT.cancel}</Button>
              </span>
            ) : confirmPath ? <MemoryButton what={MEMORY_TEXT.confirm} busyLabel={MEMORY_BUSY.confirm} run={() => act(MEMORY_TEXT.confirm, confirmPath)} /> : null}
          </span>
        </div>
      ) : null}
      <ActionResult action={mute} />
      <ActionResult action={forget} />
      <ActionResult action={save} />
    </li>
  )
}
