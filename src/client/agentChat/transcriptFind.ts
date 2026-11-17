// Find-in-transcript for the Agent Chat node (Ctrl+F style): case-insensitive scan of the rendered thread's
// text, highlighted with the CSS Custom Highlight API and scrolled to the active match.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const ALL = 'chat-find'
const ACTIVE = 'chat-find-active'

/** Visible text nodes only: closed `<details>` bodies and screen-reader-only labels never match. */
function visible(node: Node): boolean {
  const el = node.parentElement
  if (!el || el.closest('.sr-only')) return false
  const details = el.closest('details')
  return !details || details.open || Boolean(el.closest('summary'))
}

/** Every case-insensitive occurrence of `term` in the thread, in document order. */
export function findRanges(root: Element, term: string): Range[] {
  if (!term) return []
  const needle = term.toLowerCase()
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!visible(n)) continue
    const text = (n.textContent ?? '').toLowerCase()
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + needle.length)
      out.push(r)
    }
  }
  return out
}

function paint(ranges: Range[], active: number): void {
  // Not every engine ships the Highlight API; matches are then counted and scrolled to but not tinted.
  const reg = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  if (!reg || typeof Highlight === 'undefined') return
  reg.delete(ALL)
  reg.delete(ACTIVE)
  if (ranges.length === 0) return
  reg.set(ALL, new Highlight(...ranges))
  const cur = ranges[active]
  if (cur) reg.set(ACTIVE, new Highlight(cur))
}

export interface TranscriptFind {
  /** `index` is 1-based; 0 when there is nothing to show. `term` is whatever was typed last. */
  result: { index: number; total: number; term: string }
  onTerm: (term: string) => void
  onSearch: (term: string, direction: 'next' | 'prev') => void
  clear: () => void
}

/** Drives find over the `.agent-chat-thread` inside `bodyRef`; `open` false clears every highlight. */
export function useTranscriptFind(bodyRef: RefObject<HTMLElement | null>, open: boolean): TranscriptFind {
  const [result, setResult] = useState({ index: 0, total: 0, term: '' })
  const ranges = useRef<Range[]>([])

  const run = useCallback((term: string, pick: (total: number, prev: number) => number, prev: number) => {
    const root = bodyRef.current?.querySelector('.agent-chat-thread')
    ranges.current = root ? findRanges(root, term) : []
    const total = ranges.current.length
    const at = total ? pick(total, prev) : -1
    paint(ranges.current, at)
    ranges.current[at]?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
    setResult({ index: at + 1, total, term })
  }, [bodyRef])

  const onTerm = useCallback((term: string) => run(term, () => 0, 0), [run])
  const onSearch = useCallback((term: string, dir: 'next' | 'prev') => {
    // The transcript may have grown since the last scan, so rescan; same term steps, a new one restarts.
    run(term, (total, prev) => (term === result.term ? (prev + (dir === 'next' ? 1 : -1) + total) % total : 0), result.index - 1)
  }, [run, result])
  const clear = useCallback(() => {
    ranges.current = []
    paint([], 0)
    setResult({ index: 0, total: 0, term: '' })
  }, [])

  useEffect(() => { if (!open) clear() }, [open, clear])
  useEffect(() => clear, [clear])
  return { result, onTerm, onSearch, clear }
}
