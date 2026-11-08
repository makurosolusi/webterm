// Session controls of an agent chat node: model / effort / thinking (live on an open Query, else as
// options of the next open), the "/" catalog, the model list and past conversations. SDK shapes in
// @anthropic-ai/claude-agent-sdk sdk.d.ts: SlashCommand, ModelInfo, SDKSessionInfo,
// Query.setModel / applyFlagSettings({ effortLevel }) / setMaxThinkingTokens, Options.model / effort / thinking.
import type { EffortLevel, ModelInfo, Options, Query, SDKSessionInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatCommand, AgentChatConfig, AgentChatModel, AgentChatSessionSummary } from '../../shared/agentChat.wire'

export const AGENT_CHAT_EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Claude Code's defaults: its own model and effort, thinking on. */
export const AGENT_CHAT_DEFAULT_CONFIG: AgentChatConfig = { thinking: true }
/** A control request (catalog, models) that takes longer fails instead of hanging the HTTP request. */
export const AGENT_CHAT_CONTROL_TIMEOUT_MS = 20_000
/** Past conversations listed per node (newest first). */
export const AGENT_CHAT_SESSIONS_MAX = 50
/** Chars of a model id the server accepts. */
const MODEL_MAX = 200

export function toCommand(c: SlashCommand): AgentChatCommand {
  return {
    name: c.name, description: c.description ?? '', builtin: c.builtin === true,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}), ...(c.aliases?.length ? { aliases: c.aliases } : {}),
  }
}

export function toModel(m: ModelInfo): AgentChatModel {
  return {
    value: m.value, displayName: m.displayName || m.value, ...(m.description ? { description: m.description } : {}),
    ...(m.supportsEffort !== false && m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
  }
}

/** Options for the next `query()`: unset fields leave Claude Code's defaults. */
export function configOptions(c: AgentChatConfig): Pick<Options, 'model' | 'effort' | 'thinking'> {
  return {
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort ? { effort: c.effort as EffortLevel } : {}),
    ...(c.thinking ? {} : { thinking: { type: 'disabled' } }),
  }
}

/** A `POST config` body: model / effort as string (null or '' = back to default), thinking as boolean. */
export function parseConfigPatch(b: Record<string, unknown>): { patch: AgentChatConfigPatch } | { reason: string } {
  const patch: AgentChatConfigPatch = {}
  if ('model' in b) {
    if (b.model !== null && (typeof b.model !== 'string' || b.model.length > MODEL_MAX)) return { reason: `model must be a string of at most ${MODEL_MAX} characters, or null.` }
    // The picker's Auto entry (`default`) means "no explicit model": the ladder picks (agentChat.ladder.ts).
    patch.model = b.model === 'default' ? null : (b.model as string | null) || null
  }
  if ('effort' in b) {
    if (b.effort !== null && b.effort !== '' && !AGENT_CHAT_EFFORTS.includes(b.effort as EffortLevel)) return { reason: `effort must be one of ${AGENT_CHAT_EFFORTS.join(', ')}, or null.` }
    patch.effort = (b.effort as string | null) || null
  }
  if ('thinking' in b) {
    if (typeof b.thinking !== 'boolean') return { reason: 'thinking must be a boolean.' }
    patch.thinking = b.thinking
  }
  if (Object.keys(patch).length === 0) return { reason: 'Send at least one of model, effort, thinking.' }
  return { patch }
}

/** null = back to the default. */
export interface AgentChatConfigPatch { model?: string | null; effort?: string | null; thinking?: boolean }

export function mergeConfig(c: AgentChatConfig, p: AgentChatConfigPatch): AgentChatConfig {
  const model = p.model === undefined ? c.model : p.model ?? undefined
  const effort = p.effort === undefined ? c.effort : p.effort ?? undefined
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), thinking: p.thinking ?? c.thinking }
}

const failed = (what: string, err: unknown): Error =>
  new Error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })

/** Apply the fields that changed to an open Query; throws with the failing control named. */
export async function applyConfigLive(q: Query, prev: AgentChatConfig, next: AgentChatConfig): Promise<void> {
  if (next.model !== prev.model) await q.setModel(next.model).catch((err: unknown) => { throw failed(`Setting the model to ${next.model ?? 'the default'}`, err) })
  if (next.effort !== prev.effort) {
    await q.applyFlagSettings({ effortLevel: (next.effort as EffortLevel | undefined) ?? null }).catch((err: unknown) => { throw failed(`Setting effort to ${next.effort ?? 'the default'}`, err) })
  }
  // 0 = thinking off, null = the model's default (sdk.d.ts setMaxThinkingTokens).
  if (next.thinking !== prev.thinking) await q.setMaxThinkingTokens(next.thinking ? null : 0).catch((err: unknown) => { throw failed(`Turning thinking ${next.thinking ? 'on' : 'off'}`, err) })
}

export function sessionSummaries(list: readonly SDKSessionInfo[], current?: string): AgentChatSessionSummary[] {
  return [...list].sort((a, b) => b.lastModified - a.lastModified).slice(0, AGENT_CHAT_SESSIONS_MAX).map((s) => ({
    sessionId: s.sessionId, title: (s.customTitle || s.summary || s.firstPrompt || 'Untitled conversation').trim(), updatedAt: s.lastModified, current: s.sessionId === current,
  }))
}

/** `p`, or a rejection naming `what` after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}
