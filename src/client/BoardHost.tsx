// Keeps the one live <BoardCanvas> mounted in both layouts. In tab mode it is only hidden
// (visibility, never display:none: React Flow ignores zero-size nodes and would stop measuring), so
// toggling modes never remounts nodes; TabsView covers it and shows the same nodes as tabs. In
// canvas mode the node tab strip (unless turned off in View) sits above the canvas.
import type { ComponentProps } from 'react'
import BoardCanvas from './App.canvas'
import { setParkingEl } from './tabLayout.dom'
import TabsView, { type TabsViewProps } from './tabLayout.view'
import { useTabLayout } from './tabLayout.store'
import NodeTabs from './tabLayout.canvasStrip'
import { useNodeTabsShown } from './nodeTabs.visible'
import './tab-layout.css'

export interface BoardHostProps {
  canvas: ComponentProps<typeof BoardCanvas>
  tabs: TabsViewProps
}

export default function BoardHost({ canvas, tabs }: BoardHostProps) {
  const tabMode = useTabLayout().mode === 'tabs'
  const nodeTabs = useNodeTabsShown() && !tabMode
  return (
    <>
      {/* Before the board host: `.node-tabs + .board-host` moves the canvas below the strip. */}
      {nodeTabs && <NodeTabs nodes={tabs.nodes} statuses={tabs.statuses} rf={canvas.rf} onCloseNode={tabs.onCloseNode} onRenameNode={tabs.onRenameNode} />}
      <div className="board-host" data-mode={tabMode ? 'tabs' : 'canvas'} aria-hidden={tabMode || undefined}>
        <BoardCanvas {...canvas} />
      </div>
      {tabMode && <TabsView {...tabs} />}
      <div ref={setParkingEl} className="tab-parking" aria-hidden="true" />
    </>
  )
}
