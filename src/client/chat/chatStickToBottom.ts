// Keeps a chat thread pinned to its newest message while the reader is at the bottom. Re-pinning only on new
// content is not enough: the viewport shrinks when something under the list grows (the composer box, the
// status line, the todo panel) and the last message grows after render (code highlighting, images), and
// either leaves the newest line hidden under the composer. A ResizeObserver on the list and its last row
// re-pins on both. Without ResizeObserver (old browsers, jsdom) only the content effect runs.
import { useLayoutEffect, type RefObject } from 'react'

export function useStickToBottom(ref: RefObject<HTMLElement | null>, pinned: boolean, content: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !pinned) return
    el.scrollTop = el.scrollHeight
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { el.scrollTop = el.scrollHeight })
    ro.observe(el)
    if (el.lastElementChild) ro.observe(el.lastElementChild)
    return () => ro.disconnect()
  }, [ref, pinned, content])
}
