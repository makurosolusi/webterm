// The app's bottom panel: Inbox, Chat, Problems, Activity and Output as tabs of one surface.
import type { MutableRefObject } from 'react'
import type { Node, XYPosition } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import BottomPanelHost, { type BottomPanelView } from './bottomPanelHost'
import CentralControlPanel, { type useCentralControl } from './central/CentralControlPanel'
import ChatPanel from './ChatPanel'
import InboxPanel from './InboxPanel'
import { usePublishedInboxCount } from './inboxDockState'
import { useOutputView } from './output/outputPanelHost'
import ProblemsPanel, { type useProblems } from './ProblemsPanel'
import { useTimelineView } from './Timeline'

const INBOX_POLL_MS = 30000

export interface AppBottomPanelProps {
  inboxOpen: boolean
  setInboxOpen: (open: boolean) => void
  central: ReturnType<typeof useCentralControl>
  chatOpen: boolean
  setChatOpen: (open: boolean) => void
  problems: ReturnType<typeof useProblems>
  root?: string
  nodes: Node[]
  nodesRef: MutableRefObject<Node[]>
  addFlowNode: (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void
  onFocus: (id: string) => void
  workspaces: readonly Workspace[]
  liveNodes?: readonly WsNode[]
  activeId?: string | null
}

export default function AppBottomPanel(props: AppBottomPanelProps): React.JSX.Element | null {
  const { problems } = props
  const inboxCount = usePublishedInboxCount()
  const closeInbox = (): void => props.setInboxOpen(false)
  const closeChat = (): void => props.setChatOpen(false)
  const views: BottomPanelView[] = [
    {
      id: 'inbox', label: 'Inbox', tooltip: 'Operator inbox and approvals', open: props.inboxOpen, onClose: closeInbox,
      ...(inboxCount === null ? {} : { badge: inboxCount }),
      render: (actionsHost) => <InboxPanel open embedded actionsHost={actionsHost} onClose={closeInbox} pollMs={INBOX_POLL_MS} />,
    },
    {
      id: 'chat', label: 'Chat', tooltip: 'Central agent', open: props.chatOpen, onClose: closeChat,
      render: (actionsHost) => <ChatPanel open embedded actionsHost={actionsHost} onClose={closeChat} />,
    },
    {
      id: 'central', label: 'Central', tooltip: 'Central control panel', open: props.central.open, onClose: props.central.close,
      render: (actionsHost) => (
        <CentralControlPanel open actionsHost={actionsHost} enabled={props.central.enabled} />
      ),
    },
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
  ]
  return <BottomPanelHost views={views} />
}
