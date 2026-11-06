// Renders a node's content into a persistent host div (tabLayout.dom) instead of in place, so the
// same React subtree (and its xterm / iframe / Monaco) survives moving between canvas, tab pane and
// the maximize overlay (nodeMaximize.overlay).
import { memo, useCallback, useEffect, useMemo, type ComponentType, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import type { NodeProps } from '@xyflow/react'
import { NodeHostContext } from './tabLayout.context'
import { getNodeHost, placeNodeHost, releaseNodeHost } from './tabLayout.dom'
import { useTabLayout } from './tabLayout.store'
import { useMaximizedNode } from './nodeMaximize.store'
import './tab-host.css'

// Stops only React's synthetic bubbling (into the hidden canvas NodeWrapper); the native event
// keeps travelling so window/document listeners (shortcuts, click-outside) still see it.
const stopSynthetic = (e: SyntheticEvent): void => { e.isPropagationStopped = () => true }
const GUARD = {
  onClick: stopSynthetic, onDoubleClick: stopSynthetic, onMouseDown: stopSynthetic, onPointerDown: stopSynthetic,
  onWheel: stopSynthetic, onContextMenu: stopSynthetic, onKeyDown: stopSynthetic,
}

export function withTabPortal(Inner: ComponentType<NodeProps>): ComponentType<NodeProps> {
  return memo(function TabPortal(props: NodeProps) {
    const { id, data, type } = props
    const layout = useTabLayout()
    const inTab = layout.mode === 'tabs'
    const visible = !inTab || (type === 'files' ? layout.tabs.filesPanel.open : layout.tabs.active === id)
    const maxId = useMaximizedNode()
    const maximized = !inTab && maxId === id
    // Tab pane or maximize overlay: the host has left its canvas slot and must not act on the hidden NodeWrapper.
    const detached = inTab || maximized
    const state = useMemo(() => ({ inTab, visible, maximized }), [inTab, visible, maximized])
    // Never mutates node data: the canvas keeps its own collapsed/maximized values.
    const tabData = useMemo(() => (detached ? { ...data, collapsed: false, maximized: false } : data), [data, detached])
    const host = getNodeHost(id)
    // Runs before the portal subtree's own layout effects (earlier sibling), so the host is in the document.
    // `detached` in the deps re-runs it on Restore, which puts the host back here.
    const slot = useCallback((el: HTMLDivElement | null) => { if (el && !detached) placeNodeHost(id, el) }, [id, detached])
    useEffect(() => () => releaseNodeHost(id), [id])
    return (
      <>
        <div ref={slot} className="tab-host-slot" />
        {createPortal(
          <NodeHostContext.Provider value={state}>
            <div className="tab-host-guard" style={{ display: 'contents' }} {...(detached ? GUARD : null)}>
              <Inner {...props} data={tabData} />
            </div>
          </NodeHostContext.Provider>,
          host,
        )}
      </>
    )
  })
}
