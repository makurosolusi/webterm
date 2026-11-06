// App wiring of the tab layout: store <-> active workspace, the props TabsView needs, and the
// one-time Files node when a board first enters tab mode.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { BUILTIN_AGENT_IDS, assembleCmd } from '../shared/workspace'
import { uniqueTitle } from '../shared/nodeTitle'
import type { Settings } from '../shared/settings'
import type { AgentId, AgentStatus, Workspace } from '../shared/workspace'
import type { TabsViewProps } from './tabLayout.view'
import { useTabLayoutCommands } from './tabLayout.commands'
import { connectTabLayout, useTabLayout } from './tabLayout.store'

/** Point the tab-layout store at `ws`; its edits land in the active workspace payload and are saved with it. */
export function connectWorkspaceLayout(ws: Workspace, activeWsRef: RefObject<Workspace | null>, scheduleSave: () => void): void {
  connectTabLayout(ws.layout, (next) => {
    const cur = activeWsRef.current
    // A writer left over from the previous board must not stamp its layout onto the new one.
    if (cur?.id !== ws.id) return
    activeWsRef.current = { ...cur, layout: next }
    scheduleSave()
  })
}

export interface AppTabsDeps {
  activeId: string | null
  rf: RefObject<ReactFlowInstance | null>
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  settings: Settings
  closeNode: (id: string) => void
  onAddTerminal: () => void
  onAddFiles: () => void
  onAddDiff: () => void
  onAddBrowser?: () => void
  onAddAgentChat?: () => void
  onAddAgent: (cmd: string, agentId: AgentId) => void
}

/** Props for `<TabsView>` plus the layout commands; Files is created once per board on canvas -> tabs. */
export function useAppTabs(d: AppTabsDeps): TabsViewProps {
  const { activeId, rf, nodes, settings, closeNode, onAddFiles, onAddAgent } = d
  useTabLayoutCommands(closeNode)

  const mode = useTabLayout().mode
  const prev = useRef<{ id: string | null; mode: string } | null>(null)
  const autoFiles = useRef(new Set<string>())
  const latest = useRef({ nodes, onAddFiles })
  latest.current = { nodes, onAddFiles }
  useEffect(() => {
    const was = prev.current
    prev.current = { id: activeId, mode }
    // Only the canvas -> tabs transition of the same board, once per session: closing Files afterwards sticks.
    if (!activeId || mode !== 'tabs' || was?.id !== activeId || was.mode !== 'canvas' || autoFiles.current.has(activeId)) return
    autoFiles.current.add(activeId)
    if (!latest.current.nodes.some((n) => n.type === 'files')) latest.current.onAddFiles()
  }, [mode, activeId])

  const onRenameNode = useCallback((id: string, title: string) => {
    const node = rf.current?.getNode(id)
    const others = (rf.current?.getNodes() ?? []).filter((n) => n.id !== id).map((n) => (n.data as { title?: string }).title).filter((t): t is string => !!t)
    // Agents keep titles unique per board (same rule as AgentNode); other kinds take the text as typed.
    rf.current?.updateNodeData(id, { title: node?.type === 'agent' ? uniqueTitle(title, others) : title })
  }, [rf])

  const addAgent = useCallback(() => {
    const id = BUILTIN_AGENT_IDS.find((a) => !settings.disabledAgents.includes(a)) ?? BUILTIN_AGENT_IDS[0]
    onAddAgent(assembleCmd(id, settings.agentLaunchCommands[id]), id)
  }, [onAddAgent, settings.disabledAgents, settings.agentLaunchCommands])

  // Arrow wrappers: the menu/empty-state handlers receive a click event, which `addFlowNode` would read as a position.
  const { onAddTerminal, onAddBrowser, onAddDiff, onAddAgentChat } = d
  return useMemo(() => ({
    nodes, statuses: d.statuses, onCloseNode: closeNode, onRenameNode, onAddAgent: addAgent,
    onAddTerminal: () => onAddTerminal(), onAddBrowser: onAddBrowser && (() => onAddBrowser()), onAddDiff: () => onAddDiff(), onAddFiles: () => onAddFiles(),
    onAddAgentChat: onAddAgentChat && (() => onAddAgentChat()),
  }), [nodes, d.statuses, closeNode, onRenameNode, addAgent, onAddTerminal, onAddBrowser, onAddDiff, onAddFiles, onAddAgentChat])
}
