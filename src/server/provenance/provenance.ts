// "What this session loaded" for one agent node (Devin's context provenance panel; Claude Code's
// `InstructionsLoaded`): every piece of context webterm or Claude Code puts into the session, with
// its source, when it enters, and its size. Pure: the route gathers the inputs (provenance.collect.ts).
import { estimateTokens } from '../central/tools/toolRegistry'
import { type RuleFile, ruleActive } from '../rules/rulesLoader'

export type ProvenanceWhen = 'system-prompt' | 'session-start' | 'on-touch' | 'on-demand' | 'claude-code'
export type ProvenanceKind = 'house-rules' | 'awareness' | 'card' | 'procedural' | 'rule' | 'mcp-tools' | 'subagent' | 'repo-map' | 'handoff'

export interface ProvenanceItem {
  kind: ProvenanceKind
  label: string
  /** File path, flag or hook the text arrives through. */
  source: string
  when: ProvenanceWhen
  /** False = known to the session but not in its context now (a glob rule nothing matched, a manual rule). */
  loaded: boolean
  chars: number
  tokens: number
  detail?: string
}

export interface ProvenanceInput {
  houseRules: { text: string; source: string }
  awareness: string
  card: string
  procedural: { text: string; count: number }
  rules: readonly RuleFile[]
  touched: readonly string[]
  mcpTools: readonly string[]
  subagent: { name: string; text: string; source: string } | null
  repoMap: { text: string; files: number; totalFiles: number } | null
  handoff: { text: string; source: string } | null
}

export interface Provenance { items: ProvenanceItem[]; loadedChars: number; loadedTokens: number }

const item = (kind: ProvenanceKind, label: string, source: string, when: ProvenanceWhen, text: string, loaded = true, detail?: string): ProvenanceItem =>
  ({ kind, label, source, when, loaded, chars: text.length, tokens: estimateTokens(text), ...(detail ? { detail } : {}) })

const RULE_WHEN: Record<RuleFile['mode'], ProvenanceWhen> = { always: 'session-start', auto: 'on-touch', agent: 'on-demand', manual: 'on-demand' }

function ruleItem(r: RuleFile, touched: readonly string[]): ProvenanceItem {
  const active = ruleActive(r, touched)
  const scope = r.mode === 'auto' ? `globs ${r.globs.join(', ')}` : r.mode === 'agent' ? `on request: ${r.description}` : r.mode
  const detail = [`${r.source}, ${scope}`, r.error].filter(Boolean).join('; ')
  // An agent-mode rule contributes only its index line until the agent reads it.
  return item('rule', r.path, r.path, r.loadedBy === 'claude-code' ? 'claude-code' : RULE_WHEN[r.mode], r.body, active, detail)
}

/** Pure. The ordered provenance list plus the size of what is in context. */
export function buildProvenance(p: ProvenanceInput): Provenance {
  const items: ProvenanceItem[] = [
    item('house-rules', 'webterm house rules', p.houseRules.source, 'system-prompt', p.houseRules.text),
    item('awareness', 'Awareness block', 'SessionStart hook (additionalContext)', 'session-start', p.awareness),
    item('card', 'Identifier card', 'SessionStart hook (additionalContext)', 'session-start', p.card),
    item('procedural', 'Standing preferences', 'Settings > What agents remember', 'session-start', p.procedural.text, p.procedural.count > 0, `${p.procedural.count} verified`),
    ...p.rules.map((r) => ruleItem(r, p.touched)),
    item('mcp-tools', 'webterm MCP tools', '--mcp-config (webterm mcp)', 'session-start', p.mcpTools.join('\n'), p.mcpTools.length > 0, `${p.mcpTools.length} tools`),
  ]
  if (p.subagent) items.push(item('subagent', p.subagent.name, p.subagent.source, 'on-demand', p.subagent.text, true, 'read-only subagent'))
  if (p.repoMap) items.push(item('repo-map', 'Repo map', 'repo.map tool', 'on-demand', p.repoMap.text, false, `${p.repoMap.files} of ${p.repoMap.totalFiles} files`))
  if (p.handoff) items.push(item('handoff', 'Handoff card', p.handoff.source, 'session-start', p.handoff.text))
  // On-demand pieces cost nothing until called; the always-in-context total is what the session pays.
  const inContext = items.filter((i) => i.loaded && i.when !== 'on-demand')
  return { items, loadedChars: inContext.reduce((s, i) => s + i.chars, 0), loadedTokens: inContext.reduce((s, i) => s + i.tokens, 0) }
}
