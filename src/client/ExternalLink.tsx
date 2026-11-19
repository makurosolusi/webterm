// Anchor for an external web page: opens in a canvas browser node, never as a tab in the machine browser
// (canvasLinks.ts; docs/decisions/canvas-containment.md). Use it instead of `<a target="_blank">`.
import type { AnchorHTMLAttributes } from 'react'
import { openLinkInCanvas } from './canvasLinks'
import { useNodeActions } from './nodeActions'

export function ExternalLink({ href, children, ...rest }: { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'onClick'>): React.JSX.Element {
  const { openBrowserAt } = useNodeActions()
  return <a {...rest} href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); openLinkInCanvas(href, { openBrowserAt }) }}>{children}</a>
}
