import type { AgentChatEvent, AgentChatPermissionAnswer } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace.capabilities'

export type ToolEvent = Omit<Extract<AgentChatEvent, { t: 'tool' }>, 'seq'>
export type PermissionEvent = Omit<Extract<AgentChatEvent, { t: 'permission' }>, 'seq'>
export type PermissionOutcome = 'open' | Extract<AgentChatEvent, { t: 'permissionResolved' }>['outcome']

/** One tool call card; `children` = nested subagent content (Task, by parentId). */
export interface ToolCardProps { tool: ToolEvent; loadFull: (toolUseId: string) => Promise<string>; children?: React.ReactNode }
/** Shared by permission/question/plan cards. `answer` rejects on a failed POST: show it inline with Retry. */
export interface PermissionCardProps { request: PermissionEvent; outcome: PermissionOutcome; answer: (a: AgentChatPermissionAnswer) => Promise<void> }
export interface PlanCardProps extends PermissionCardProps { setMode: (m: AgentPermissionMode) => Promise<void> }
export interface ModePickerProps { mode: AgentPermissionMode; onChange: (m: AgentPermissionMode) => Promise<void>; disabled?: boolean
  /** Set for a server-locked preset: the chip reads "Locked", cannot switch, and this is its explanation. */
  lockedReason?: string }
