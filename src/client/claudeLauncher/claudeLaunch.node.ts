// What a new agent node records about its Claude launch profile (builtin claude only).
import type { AgentId } from '../../shared/workspace'

/** Builtin claude records the current default profile; every other agent records nothing. */
export const recordedClaudeProfile = (agentId: AgentId, defaultProfileId: string): { claudeProfileId?: string } =>
  agentId === 'claude' && defaultProfileId ? { claudeProfileId: defaultProfileId } : {}
