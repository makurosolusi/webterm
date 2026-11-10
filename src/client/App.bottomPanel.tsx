// The app's bottom panel: Problems, Activity, Output and Tasks as tabs of one surface. Central chat (with
// the Needs-you strip that replaced the Inbox) and the Central control panel live in the secondary
// side bar (`App.secondarySideBar`).
import type { MutableRefObject } from 'react'
import type { Node, XYPosition } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import BottomPanelHost, { type BottomPanelView } from './bottomPanelHost'
import { useOutputView } from './output/outputPanelHost'
import ProblemsPanel, { type useProblems } from './ProblemsPanel'
import { useTimelineView } from './Timeline'
import { useTaskBoardView } from './central/work/taskBoardView'

export interface AppBottomPanelProps {
  problems: ReturnType<typeof useProblems>
  root?: string
  nodes: Node[]
  nodesRef: MutableRefObject<Node[]>
  addFlowNode: (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void
  onFocus: (id: string) => void
  workspaces: readonly Workspace[]
  liveNodes?: readonly WsNode[]
  activeId?: string | null
  /** Central capability is on; the Tasks tab exists only then. */
  centralEnabled?: boolean
}

export default function AppBottomPanel(props: AppBottomPanelProps): React.JSX.Element | null {
  const { problems } = props
  const views: BottomPanelView[] = [
    {
      id: 'problems', label: 'Problems', open: problems.open && problems.workspaceId !== null,
      badge: problems.list.length, onClose: () => problems.setOpen(false),
      render: (actionsHost) => (
        <ProblemsPanel problems={problems} root={props.root} nodes={props.nodes} nodesRef={props.nodesRef}
          addFlowNode={props.addFlowNode} onFocus={props.onFocus} actionsHost={actionsHost} />
      ),
    },
    useTimelineView({ workspaces: props.workspaces, liveNodes: props.liveNodes, activeId: props.activeId, onFocusNode: props.onFocus }),
    useOutputView(),
    useTaskBoardView(props.centralEnabled === true),
  ]
  return <BottomPanelHost views={views} />
}
