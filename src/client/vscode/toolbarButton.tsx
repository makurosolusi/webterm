import { forwardRef, useCallback, useEffect, useRef, type ComponentProps, type CSSProperties, type MouseEvent } from 'react'
import * as Lit from '@vscode-elements/react-elements'
import { keepRefCleanup } from './refCleanup'

const Inner = keepRefCleanup(Lit.VscodeToolbarButton)
type InnerProps = ComponentProps<typeof Inner>
type Host = HTMLElement & { updateComplete?: Promise<unknown> }

const DISABLED_HOST: CSSProperties = { opacity: 0.4 }

/** Sets the disabled ARIA and look on the shadow `<button>`, the element that actually takes focus and the role. */
function paintInner(host: Host, disabled: boolean): void {
  const button = host.shadowRoot?.querySelector('button')
  if (!button) return
  if (disabled) button.setAttribute('aria-disabled', 'true')
  else button.removeAttribute('aria-disabled')
  // Inline beats the shadow stylesheet's `cursor: pointer` and `:hover` background (no ::part to target).
  button.style.cursor = disabled ? 'default' : ''
  button.style.background = disabled ? 'transparent' : ''
}

/**
 * `vscode-toolbar-button` (vscode-elements 2.5.1) has no `disabled` property, so this adds one:
 * `aria-disabled` on the inner focusable `<button>` (and on the host as a styling/test hook), VS Code's
 * dimmed look, and no activation. It stays focusable and hoverable so its tooltip still explains why.
 * Enter/Space on a button dispatch `click`, so stopping click in the capture phase blocks all three,
 * including the element's own toggle.
 */
export const ToolbarButton = forwardRef<Host, InnerProps & { disabled?: boolean }>(function ToolbarButton(
  { disabled = false, style, onClick, onClickCapture, ...rest },
  ref,
) {
  const host = useRef<Host | null>(null)
  const setRef = useCallback((el: Host | null) => {
    host.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }, [ref])
  useEffect(() => {
    const el = host.current
    if (!el) return
    let live = true
    paintInner(el, disabled)
    // First mount: lit renders the shadow button after React's commit.
    void el.updateComplete?.then(() => { if (live) paintInner(el, disabled) })
    return () => { live = false }
  }, [disabled])
  const capture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (disabled) { e.preventDefault(); e.stopPropagation(); return }
    onClickCapture?.(e as never)
  }, [disabled, onClickCapture])
  return (
    <Inner
      {...rest}
      ref={setRef as never}
      aria-disabled={disabled ? 'true' : undefined}
      style={disabled ? { ...DISABLED_HOST, ...style } : style}
      onClickCapture={capture as never}
      onClick={disabled ? undefined : onClick}
    />
  )
})
