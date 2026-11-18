// The downloads list of a node as a non-modal dialog under its header button (WAI-ARIA: role=dialog, labelled, Esc closes and
// focus returns to the button, a press outside closes, Tab stays natural). Rendered in a portal so canvas zoom and the node's
// own clipping never cut it; placed from the button's rectangle and clamped to the window.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { downloadsOfNode } from '../../shared/browser.downloads'
import type { DownloadItem } from '../../shared/browser.downloads'
import { portalContainer } from '../components/vscode/portalContainer'
import { BrowserDownloadRow } from './BrowserDownloadRow'
import { DL_TEXT } from './browserDownloads.text'
import type { SpeedMap } from './browserDownloads.state'
import './browserDownloads.css'

const POPOVER_W = 380 // px; narrower windows get the window width minus the margin
const MARGIN = 8
const GAP = 4

export interface BrowserDownloadsPopoverProps {
  nodeId: string
  items: readonly DownloadItem[]
  speeds: SpeedMap
  /** The header button: placement anchor, excluded from "press outside", and where focus returns. */
  anchor: HTMLElement
  id: string
  onClose: () => void
}

function place(anchor: HTMLElement): { top: number; left: number; width: number } {
  const r = anchor.getBoundingClientRect()
  const width = Math.min(POPOVER_W, window.innerWidth - MARGIN * 2)
  return { top: r.bottom + GAP, left: Math.max(MARGIN, Math.min(r.right - width, window.innerWidth - width - MARGIN)), width }
}

export function BrowserDownloadsPopover({ nodeId, items, speeds, anchor, id, onClose }: BrowserDownloadsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(() => place(anchor))
  const rows = downloadsOfNode(items, nodeId)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const dismiss = (returnFocus: boolean) => { close.current(); if (returnFocus) anchor.focus() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(true) } }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) dismiss(false)
    }
    const onResize = () => setPos(place(anchor))
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref} id={id} className="bdl-pop nodrag nopan nowheel" role="dialog" aria-label={DL_TEXT.title} tabIndex={-1}
      style={{ top: pos.top, left: pos.left, width: pos.width }} data-browser-downloads-popover
    >
      <div className="bdl-head">{DL_TEXT.title}</div>
      {rows.length === 0 ? (
        <div className="bdl-empty" role="status">
          <div className="bdl-empty-title">{DL_TEXT.empty}</div>
          <div className="bdl-empty-hint">{DL_TEXT.emptyHint}</div>
        </div>
      ) : (
        <ul className="bdl-list" aria-label={DL_TEXT.title}>
          {rows.map((i) => <BrowserDownloadRow key={i.id} nodeId={nodeId} item={i} bps={speeds[i.id]?.bps ?? 0} />)}
        </ul>
      )}
    </div>,
    portalContainer(),
  )
}
