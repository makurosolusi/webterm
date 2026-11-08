// Agent chat's default model when the node has no explicit choice: the model ladder's pick for the
// workspace (its `projectModels` override, else the ladder default). An explicit per-node model or
// effort always wins. Pure ladder + settings override, no ledger: the pool stays free of bun:sqlite.
// ponytail: no budget pressure here (no db at hand); pass dailyBudget through when the chat must obey the cap.
import type { AgentChatConfig, AgentChatModel } from '../../shared/agentChat.wire'
import { resolveModel, type ModelPick } from '../models/modelLadder'
import { projectModelOverride } from '../models/modelOverride'

/** Value Claude Code lists for "use the default model" (mirrors the client's DEFAULT_MODEL). */
export const AGENT_CHAT_DEFAULT_MODEL = 'default'

// Kind 'central': Agent Chat is interactive like Central, so it shares Central's T2 (Sonnet · medium) default.
export function agentChatLadderPick(workspaceId?: string): ModelPick {
  return resolveModel({ kind: 'central', override: projectModelOverride(workspaceId) })
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** "Auto (ladder: Sonnet · medium)" for the picker's default entry. */
export function agentChatLadderLabel(p: ModelPick): string {
  const parts = [p.model ? cap(p.model) : 'CLI default', p.effort].filter(Boolean).join(' · ')
  return `Auto (${p.reason === 'user override' ? 'workspace' : 'ladder'}: ${parts})`
}

/**
 * The config the CLI actually runs: a missing model comes from the ladder, and so does a missing effort
 * when the model did too (an explicit model keeps the CLI's own effort for it).
 */
export function withLadderDefault(c: AgentChatConfig, p: ModelPick): AgentChatConfig {
  if (c.model && c.model !== AGENT_CHAT_DEFAULT_MODEL) return c // `default` (the Auto entry, or a config stored before the ladder) = no choice
  const effort = c.effort ?? p.effort ?? undefined
  const { model: _picked, ...rest } = c
  return { ...rest, ...(p.model ? { model: p.model } : {}), ...(effort ? { effort } : {}) }
}

/** The model list with its `default` entry named after the resolved default (prepended when the CLI lists none). */
export function withLadderEntry(models: AgentChatModel[], p: ModelPick): AgentChatModel[] {
  const own = models.find((m) => m.value === AGENT_CHAT_DEFAULT_MODEL)
  // Effort levels of the model that will actually run (the ladder's alias entry), else the CLI default's.
  const efforts = models.find((m) => m.value === p.model)?.efforts ?? own?.efforts
  const entry: AgentChatModel = {
    ...(efforts ? { efforts } : {}), value: AGENT_CHAT_DEFAULT_MODEL, displayName: agentChatLadderLabel(p),
    description: p.reason === 'user override' ? 'Set for this workspace in Settings › Agent › Models' : 'Picked by the model ladder',
  }
  return own ? models.map((m) => (m === own ? entry : m)) : [entry, ...models]
}
