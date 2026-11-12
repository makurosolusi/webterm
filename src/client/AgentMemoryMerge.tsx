// Near-duplicate memories ("reply in Indonesian" / "respond in Indonesian"): ONE suggestion line above the list,
// "2 memories look alike · Merge". Merge opens the kept text (newer, else longer) for editing; confirming edits it
// if changed, then forgets the other through the existing routes. Never automatic, and the server has no restore,
// so the confirm says it cannot be undone. "Keep both" hides that pair until the panel reloads.
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { ctl, MEMORY_TEXT, type MemoryItem } from './AgentMemory.api'

/** Sørensen–Dice over normalized word sets. 0.8 catches one swapped word in a short sentence ("reply"/"respond"),
 *  while two different rules sharing a few words ("Use tabs" / "Use spaces" = 0.5) stay apart. */
export const NEAR_DUPLICATE_MIN_SIMILARITY = 0.8

export const MERGE_TEXT = {
  alike: (n: number) => `${n} memories look alike`,
  merge: 'Merge', merging: 'Merging…', keepBoth: 'Keep both', cancel: 'Cancel',
  keepLabel: 'Merged memory',
  forgets: (text: string) => `Forgets: ${text}`,
  noUndo: 'The other memory is forgotten. This cannot be undone.',
  done: 'Merged: kept one memory, forgot the other',
} as const

const words = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean))

/** 0..1: how many words two texts share (lowercase, punctuation ignored). */
export function textSimilarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return (2 * both) / (x.size + y.size)
}

const pairKey = (a: string, b: string): string => [a, b].sort().join('|')

/** First look-alike pair among active memories as [keep, forget]: keep the newer one, on a tie the longer one.
 *  Muted and web-page memories are skipped (not active / cannot be edited). */
export function nearDuplicatePair(items: readonly MemoryItem[], skip: ReadonlySet<string> = new Set()): [MemoryItem, MemoryItem] | null {
  const active = items.filter((m) => !m.suppressed && m.trust !== 'external')
  // ponytail: O(n²) word-set compare; fine for hundreds of memories, index by word if lists grow to thousands.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!
      const b = active[j]!
      if (skip.has(pairKey(a.id, b.id)) || textSimilarity(a.text, b.text) < NEAR_DUPLICATE_MIN_SIMILARITY) continue
      const aFirst = a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.text.length >= b.text.length
      return aFirst ? [a, b] : [b, a]
    }
  }
  return null
}

/** Writes one memory request then reloads the list (AgentMemory's `act`). */
type MergeAct = (what: string, method: string, path: string, body?: unknown) => Promise<void>

export function MergeSuggestion({ items, act }: { items: readonly MemoryItem[]; act: MergeAct }): React.JSX.Element | null {
  const [skip, setSkip] = useState<ReadonlySet<string>>(new Set())
  const [draft, setDraft] = useState<string | null>(null)
  const pair = useMemo(() => nearDuplicatePair(items, skip), [items, skip])
  const merge = useAction(async () => {
    if (!pair || draft === null) return
    const [keep, drop] = pair
    const text = draft.trim()
    // Edit first: if it fails, nothing was forgotten.
    if (text !== keep.text) await act(MERGE_TEXT.merge, 'POST', ctl(keep.id, 'edit'), { text })
    await act(MERGE_TEXT.merge, 'POST', ctl(drop.id, 'forget'))
    setDraft(null)
  }, { label: MERGE_TEXT.merge, success: () => MERGE_TEXT.done, failure: (e) => MEMORY_TEXT.failed(MERGE_TEXT.merge, errorCause(e)) })
  if (!pair) return <ActionResult action={merge} />
  const [keep, drop] = pair
  return (
    <div data-testid="memory-merge" className="flex flex-col gap-1">
      {draft === null ? (
        <p className="m-0 flex flex-wrap items-center gap-1 opacity-80">
          <span className="codicon codicon-copy" aria-hidden="true" />
          <span>{MERGE_TEXT.alike(2)}</span>
          <span aria-hidden="true">·</span>
          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setDraft(keep.text)}>{MERGE_TEXT.merge}</Button>
          <span aria-hidden="true">·</span>
          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setSkip(new Set([...skip, pairKey(keep.id, drop.id)]))}>{MERGE_TEXT.keepBoth}</Button>
        </p>
      ) : (
        <div role="group" aria-label={MERGE_TEXT.merge} className="flex flex-col gap-1 rounded border border-(--vscode-panel-border) p-2">
          <Input aria-label={MERGE_TEXT.keepLabel} value={draft} maxLength={1200} onChange={(e) => setDraft(e.target.value)} className="w-full min-w-0" />
          <p className="m-0 break-words opacity-70 [overflow-wrap:anywhere]">{MERGE_TEXT.forgets(drop.text)}</p>
          <p className="m-0 opacity-70">{MERGE_TEXT.noUndo}</p>
          <span className="flex flex-wrap justify-end gap-1">
            <ActionButton size="sm" action={merge} busyLabel={MERGE_TEXT.merging} disabled={draft.trim() === ''}>{MERGE_TEXT.merge}</ActionButton>
            <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>{MERGE_TEXT.cancel}</Button>
          </span>
        </div>
      )}
      <ActionResult action={merge} />
    </div>
  )
}
