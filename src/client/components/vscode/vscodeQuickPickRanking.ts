import { rankTargets } from '@/paletteTargets'
import type { VscodeQuickPickItem } from './vscodeQuickPick'

/** Ranks items with the shared palette scorer; description and detail are searchable, the keybinding is not. */
export function defaultRank(items: VscodeQuickPickItem[], query: string): VscodeQuickPickItem[] {
  if (!query.trim()) return items
  const byId = new Map(items.map((item) => [item.id, item]))
  const targets = items.map((item) => ({
    id: item.id,
    label: item.label,
    hint: [item.description, item.detail].filter(Boolean).join(' '),
  }))
  return rankTargets(targets, query, targets.length)
    .map((target) => byId.get(target.id))
    .filter((item): item is VscodeQuickPickItem => item !== undefined)
}

/** Orders items by a caller score (lower first, stable); `null` hides the item. */
export function customRank(
  items: VscodeQuickPickItem[],
  query: string,
  rank: (item: VscodeQuickPickItem, query: string) => number | null,
): VscodeQuickPickItem[] {
  const scored: { item: VscodeQuickPickItem; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const score = rank(item, query)
    if (score !== null) scored.push({ item, score, index })
  })
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.map((entry) => entry.item)
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Splits a label into matched and unmatched runs for the query: the contiguous
 * substring when present, otherwise an in-order character subsequence, otherwise none.
 */
export function highlightSegments(label: string, query: string): HighlightSegment[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text: label, match: false }]
  const hay = label.toLowerCase()
  const marks = new Array<boolean>(label.length).fill(false)
  const at = hay.indexOf(needle)
  if (at >= 0) {
    marks.fill(true, at, at + needle.length)
  } else {
    let cursor = 0
    for (const ch of needle) {
      if (ch === ' ') continue
      const found = hay.indexOf(ch, cursor)
      if (found === -1) return [{ text: label, match: false }]
      marks[found] = true
      cursor = found + 1
    }
  }
  const segments: HighlightSegment[] = []
  for (let i = 0; i < label.length; i += 1) {
    const last = segments[segments.length - 1]
    if (last && last.match === marks[i]) last.text += label[i]
    else segments.push({ text: label[i], match: marks[i] })
  }
  return segments
}
