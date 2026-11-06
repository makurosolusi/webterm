// "New Agent Chat" entry point for the board: the node maker plus its registered command. The Dock
// and ⌘K reach it through the command (like `diff.new`), so neither needs an extra prop.
import { useCallback, useMemo, useRef } from 'react'
import type { XYPosition } from '@xyflow/react'
import { agentConfig } from '../shared/workspace'
import type { Workspace, WsNode } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import { AGENT_CHAT_KIND } from '../shared/agentChat.shape'
import { recordedClaudeProfile } from './claudeLauncher/claudeLaunch.node'
import { useRegisterCommands, type Command } from './commandRegistry'
import { randomId } from './randomId'

/** Id of the registered "new Agent Chat node" command; the Dock runs it. */
export const AGENT_CHAT_COMMAND_ID = 'agentChat.new'
/** Default title, so the node reads the same in its chrome, the sidebar and Recently closed. */
export const AGENT_CHAT_TITLE = 'Agent Chat'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

/** The node a new Agent Chat starts as: Claude, workspace cwd, default launch profile recorded. */
export function newAgentChatNode(ws: Workspace, defaultClaudeProfileId: string): Omit<WsNode, 'x' | 'y'> {
  // No `chatSessionId`: it is minted by the first turn's `system/init`, the same reason AgentNode
  // is born without a `sessionId` (a pre-minted id would be resumed before it exists on disk).
  return {
    id: randomId(), kind: AGENT_CHAT_KIND, agentId: 'claude', cwd: ws.cwd, title: AGENT_CHAT_TITLE,
    color: agentConfig('claude')?.color, ...recordedClaudeProfile('claude', defaultClaudeProfileId),
  }
}

/** Adds Agent Chat nodes; undefined (and no command) while Claude is disabled in settings. */
export function useAgentChatAdd(addFlowNode: AddFlowNode, settings: Pick<Settings, 'disabledAgents' | 'defaultClaudeProfileId'>): ((at?: XYPosition) => void) | undefined {
  const profileId = settings.defaultClaudeProfileId
  const add = useCallback((at?: XYPosition) => addFlowNode((_, ws) => newAgentChatNode(ws, profileId), at), [addFlowNode, profileId])
  const enabled = !settings.disabledAgents.includes('claude')
  // Through a ref: `add` changes with the profile, and re-registering would re-render every registry reader.
  const ref = useRef(add)
  ref.current = add
  const commands = useMemo<Command[]>(() => (enabled ? [{ id: AGENT_CHAT_COMMAND_ID, label: 'Agent Chat: New Agent Chat', run: () => ref.current() }] : []), [enabled])
  useRegisterCommands(commands)
  return enabled ? add : undefined
}
