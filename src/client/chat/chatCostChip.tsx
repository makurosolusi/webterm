// Per-turn cost chip on a Central reply: model alias, ladder tier and cost; cache share and tokens on hover.
import type { ChatUsage } from './chatTypes'

const ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
/** Below a cent the cost needs more digits to say anything. */
const CENT_MICROS = 10_000

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${(n / 1e3).toFixed(1)}k` : String(n))

/** `claude-sonnet-5-5` -> `sonnet`; an unknown id is shown as-is, no id as `model ?`. */
export function modelAlias(model: string | undefined): string {
  if (!model) return 'model ?'
  return ALIASES.find((a) => model.toLowerCase().includes(a)) ?? model
}

export function costText(micros: number): string {
  return `$${(micros / 1e6).toFixed(micros > 0 && micros < CENT_MICROS ? 4 : 2)}`
}

/** Share of the prompt side served from cache (reads over all input-side tokens), 0..100. */
export function cacheShare(u: ChatUsage): number {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  return prompt > 0 ? Math.round((u.cacheReadTokens / prompt) * 100) : 0
}

export function ChatCostChip({ usage }: { usage: ChatUsage }) {
  const parts = [modelAlias(usage.model), usage.tier, costText(usage.costMicros)].filter(Boolean)
  const title = `${cacheShare(usage)}% of input from cache · ${compact(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in / ${compact(usage.outputTokens)} out${usage.effort ? ` · ${usage.effort} effort` : ''}`
  return <span className="chat-cost-chip" title={title} aria-label={`Turn cost: ${parts.join(', ')}. ${title}`}>{parts.join(' · ')}</span>
}
