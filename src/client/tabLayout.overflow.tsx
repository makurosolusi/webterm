// "⋯ N more" end of the tab strip: tabs that do not fit (even after shrinking to icon + short title)
// are listed in a filterable, keyboard-driven quick pick, like VS Code's "Show Opened Editors".
import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { VscodeQuickPick } from '@/components/vscode/vscodeQuickPick'
import type { TabItem } from './tabLayout.strip'

/** Ids of the tabs in `list` not fully inside its visible box (1px slack for subpixel layout). */
export function hiddenTabIds(list: HTMLElement): string[] {
  const box = list.getBoundingClientRect()
  return [...list.querySelectorAll<HTMLElement>('[data-tab-id]')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1 })
    .map((el) => el.dataset.tabId as string)
}

/** Hidden tab ids, re-measured on resize, scroll and whenever the tabs change. */
export function useHiddenTabs(listRef: RefObject<HTMLElement | null>, items: readonly TabItem[]): string[] {
  const [hidden, setHidden] = useState<string[]>([])
  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const next = hiddenTabIds(el)
    setHidden((prev) => (prev.join('\n') === next.join('\n') ? prev : next))
  }, [listRef])
  useLayoutEffect(measure, [measure, items])
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    el.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    // jsdom has no ResizeObserver; the window resize listener covers it there.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); ro?.disconnect() }
  }, [listRef, measure])
  return hidden
}

export interface TabOverflowProps {
  items: readonly TabItem[]
  hidden: readonly string[]
  onActivate: (id: string) => void
}

export default function TabOverflow({ items, hidden, onActivate }: TabOverflowProps) {
  const [open, setOpen] = useState(false)
  if (hidden.length === 0) return null
  const set = new Set(hidden)
  const rows = items.filter((t) => set.has(t.id)).map((t) => ({
    id: t.id, label: t.title, icon: <span className={`codicon codicon-${t.icon}`} aria-hidden="true" />,
  }))
  return (
    <>
      <Button
        variant="ghost" size="sm" className="tabs-strip__more" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${hidden.length} more tabs`} onClick={() => setOpen((v) => !v)}
      >⋯ {hidden.length} more</Button>
      <VscodeQuickPick
        open={open} onClose={() => setOpen(false)} triggerSelector=".tabs-strip__more"
        ariaLabel="Hidden tabs" placeholder="Filter hidden tabs" emptyText="No matching tabs" hint=""
        items={rows} onSelect={(id) => { setOpen(false); onActivate(id) }}
      />
    </>
  )
}
