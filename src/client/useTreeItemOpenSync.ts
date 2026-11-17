// One-way sync DOM -> React for the fold of `vscode-tree-item` branches. The library owns `open` in
// the DOM and flips it on keyboard (Left/Right), click and programmatic paths without any change
// event; `open` reflects to an attribute, so one observer on the tree sees every source.
import { useEffect, useRef, type RefObject } from 'react'

/** Report `item.open` whenever any branch's `open` attribute changes; the caller ignores echoes of its own writes. */
export function useTreeItemOpenSync(
  treeRef: RefObject<HTMLElement | null>,
  onChange: (item: Element, open: boolean) => void,
  /** The observer exists only while the Sessions view is the visible one. */
  active: boolean,
): void {
  const ref = useRef(onChange)
  ref.current = onChange
  useEffect(() => {
    const tree = treeRef.current
    if (!tree || !active) return
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target instanceof HTMLElement) ref.current(r.target, (r.target as HTMLElement & { open?: boolean }).open === true)
      }
    })
    observer.observe(tree, { subtree: true, attributes: true, attributeFilter: ['open'] })
    return () => observer.disconnect()
  }, [treeRef, active])
}
