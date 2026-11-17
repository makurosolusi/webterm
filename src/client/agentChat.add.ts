// "New Agent Chat" entry point for the board: the node maker plus its registered command. The Dock
// and ⌘K reach it through the command (like `diff.new`), so neither needs an extra prop.
import { useCallback, useMemo, useRef } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { Workspace, WsNode } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import { AGENT_CHAT_TITLE, buildAgentChatNode } from '../shared/agentChat.node'
import { useRegisterCommands, type Command } from './commandRegistry'
import { randomId } from './randomId'

/** Id of the registered "new Agent Chat node" command; the Dock runs it. */
export const AGENT_CHAT_COMMAND_ID = 'agentChat.new'
export { AGENT_CHAT_TITLE }
export const SKILL_AUTHOR_TITLE = 'Skill author'

type AddFlowNode = (make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => void

/** The node a new Agent Chat starts as: Claude, workspace cwd, default launch profile recorded. */
export const newAgentChatNode = (ws: Workspace, defaultClaudeProfileId: string): Omit<WsNode, 'x' | 'y'> =>
  buildAgentChatNode(randomId(), ws.cwd, defaultClaudeProfileId)

/** Adds a skill-author chat (new skill, or an edit of `target`) and returns its node id; undefined while Claude is disabled. */
export function useSkillAuthorAdd(addFlowNode: AddFlowNode, settings: Pick<Settings, 'disabledAgents' | 'defaultClaudeProfileId'>): ((target?: string) => string) | undefined {
  const profileId = settings.defaultClaudeProfileId
  const add = useCallback((target?: string) => {
    const id = randomId()
    addFlowNode((_, ws) => ({ ...buildAgentChatNode(id, ws.cwd, profileId, { preset: 'skill-author', ...(target ? { presetTarget: target } : {}) }), title: SKILL_AUTHOR_TITLE }))
    return id
  }, [addFlowNode, profileId])
  return settings.disabledAgents.includes('claude') ? undefined : add
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
