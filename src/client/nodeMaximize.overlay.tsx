// The one slot a maximized node's host moves into. Rendered as a React Flow child, so it covers
// exactly the canvas pane (not the activity bar, dock, side or bottom panels) above nodes, minimap
// and panels, at 1:1 scale outside the pan/zoom transform. data-tab-node + data-id make it the
// node's root for nodeRoot (focus, reveal, status glow), like a tab pane.
import { useCallback, useEffect } from 'react'
import type { Node } from '@xyflow/react'
import { parkNodeHost, placeNodeHost } from './tabLayout.dom'
import { useTabLayout } from './tabLayout.store'
import { setMaximizedNode, useMaximizedNode } from './nodeMaximize.store'
import './node-maximize.css'

function MaximizeSlot({ id }: { id: string }) {
  // Detach parks the host so it never leaves the document; the canvas slot then takes it back.
  const ref = useCallback((el: HTMLDivElement | null) => { if (el) placeNodeHost(id, el); else parkNodeHost(id) }, [id])
  return <div ref={ref} className="node-maximize" data-tab-node="" data-id={id} />
}

export default function NodeMaximizeOverlay({ nodes }: { nodes: readonly Node[] }) {
  const id = useMaximizedNode()
  const tabMode = useTabLayout().mode === 'tabs'
  const shown = id !== null && !tabMode && nodes.some((n) => n.id === id)
  // A deleted node or a switch to tab layout ends the maximize instead of leaving it pending.
  useEffect(() => { if (id !== null && !shown) setMaximizedNode(null) }, [id, shown])
  // The board unmounts on workspace switch (BoardHost is keyed by workspace): the next one starts restored.
  useEffect(() => () => setMaximizedNode(null), [])
  return shown ? <MaximizeSlot key={id} id={id} /> : null
}
