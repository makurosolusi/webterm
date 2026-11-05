// Keeps the one live <BoardCanvas> mounted in both layouts. In tab mode it is only hidden
// (visibility, never display:none: React Flow ignores zero-size nodes and would stop measuring), so
// toggling modes never remounts nodes; TabsView covers it and shows the same nodes as tabs.
import type { ComponentProps } from 'react'
import BoardCanvas from './App.canvas'
import TabsView, { type TabsViewProps } from './tabLayout.view'
import { useTabLayout } from './tabLayout.store'
import './tab-layout.css'

export interface BoardHostProps {
  canvas: ComponentProps<typeof BoardCanvas>
  tabs: TabsViewProps
}

export default function BoardHost({ canvas, tabs }: BoardHostProps) {
  const tabMode = useTabLayout().mode === 'tabs'
  return (
    <>
      <div className="board-host" data-mode={tabMode ? 'tabs' : 'canvas'} aria-hidden={tabMode || undefined}>
        <BoardCanvas {...canvas} />
      </div>
      {tabMode && <TabsView {...tabs} />}
    </>
  )
}
