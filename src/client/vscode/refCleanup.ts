import { createElement, forwardRef, useCallback, useRef, type ForwardRefExoticComponent } from 'react'

type RefCallback = (el: Element | null) => void | (() => void)

/**
 * Give a `@lit/react` wrapper React 19 ref-callback semantics.
 *
 * `createComponent` passes the caller's ref through its own `useCallback((node) => { ref(node) })`
 * and drops what the ref returns, so a ref cleanup never runs: every re-render with a new ref callback
 * re-attached its listeners without removing the old ones (ui-210-2). This layer keeps the cleanup the
 * ref returned and runs it where React would, on the `null` call, instead of calling the ref with `null`.
 */
export function keepRefCleanup<C extends ForwardRefExoticComponent<never>>(Inner: C): C {
  const Outer = forwardRef<Element, Record<string, unknown>>((props, ref) => {
    const cleanup = useRef<(() => void) | null>(null)
    const adapted = useCallback((el: Element | null) => {
      const pending = cleanup.current
      cleanup.current = null
      if (pending) {
        pending()
        if (el === null) return
      }
      if (typeof ref === 'function') {
        const result = (ref as RefCallback)(el)
        if (el !== null && typeof result === 'function') cleanup.current = result
      } else if (ref) ref.current = el
    }, [ref])
    return createElement(Inner as unknown as ForwardRefExoticComponent<Record<string, unknown>>, { ...props, ref: adapted })
  })
  Outer.displayName = Inner.displayName
  return Outer as unknown as C
}
