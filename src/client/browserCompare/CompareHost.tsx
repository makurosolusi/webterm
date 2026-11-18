// Entry point of the feature for a browser node: asks which two panes, then mounts the overlay over the node's page area.
// `anchor` is any element inside the node (the Split button); everything is resolved from it, so the host needs no props
// from the node itself.
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { listPanes } from './capture'
import { CompareOverlay } from './CompareOverlay'
import { ComparePicker } from './ComparePicker'

export interface CompareHostProps {
  anchor: Element | null
  onWake: (tabId: string) => void
  onClose: () => void
}

export function CompareHost({ anchor, onWake, onClose }: CompareHostProps) {
  const node = anchor?.closest('.browser-node') ?? null
  const panes = useMemo(() => (node ? listPanes(node) : []), [node])
  const [ids, setIds] = useState<{ left: string; right: string } | null>(null)
  if (!node || panes.length < 2) return null // the menu row is disabled below two panes; a stale open closes itself
  if (!ids) return <ComparePicker panes={panes} onConfirm={(left, right) => setIds({ left, right })} onCancel={onClose} />
  const names = Object.fromEntries(panes.map((p) => [p.tabId, p.label]))
  const overlay = <CompareOverlay root={node} ids={ids} names={names} onClose={onClose} onWake={onWake} />
  const body = node.querySelector('.browser-body')
  return body ? createPortal(overlay, body) : overlay
}
