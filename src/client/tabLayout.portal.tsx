// Renders a node's content into a persistent host div (tabLayout.dom) instead of in place, so the
// same React subtree (and its xterm / iframe / Monaco) survives moving between canvas, tab pane and
// the maximize overlay (nodeMaximize.overlay).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, type ComponentType, type KeyboardEvent, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import type { NodeProps } from '@xyflow/react'
import { NodeHostContext } from './tabLayout.context'
import { claimNodeHost, getNodeHost, placeNodeHost, releaseNodeHost } from './tabLayout.dom'
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
// Keys from a portaled popup (Radix menus, Select, dialogs) bubble through the React tree into the
// NodeWrapper, whose keyboard a11y moves the selected node on arrows and toggles selection on
// Enter/Escape. Stop only those: a key whose target is inside the node's own DOM keeps reaching it.
const stopPortalKeys = (e: KeyboardEvent<HTMLDivElement>): void => {
  if (!e.currentTarget.contains(e.target as Node)) stopSynthetic(e)
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
    // Claimed in the layout phase so a same-id remount (type change) owns the host before the old
    // portal's passive unmount cleanup runs; that cleanup then leaves the host alone.
    const [owner] = useState(() => Symbol(id))
    useLayoutEffect(() => claimNodeHost(id, owner), [id, owner])
    useEffect(() => () => releaseNodeHost(id, owner), [id, owner])
    return (
      <>
        <div ref={slot} className="tab-host-slot" />
        {createPortal(
          <NodeHostContext.Provider value={state}>
            <div className="tab-host-guard" style={{ display: 'contents' }} onKeyDown={stopPortalKeys} {...(detached ? GUARD : null)}>
              <Inner {...props} data={tabData} />
            </div>
          </NodeHostContext.Provider>,
          host,
        )}
      </>
    )
  })
}
