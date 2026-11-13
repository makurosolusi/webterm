// Shared vocabulary of Settings › Rules & secrets: the Who/What/Where choices offered when making or
// trying a rule (PolicyRuleForm, PolicySimulator) and the plain-words reading of a stored rule's patterns.
import type { ComboPreset } from './SettingsCombobox'

/** The three effects of a rule, as a segmented choice (rule list, form, simulator). */
export const RULE_EFFECTS = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
] as const satisfies ReadonlyArray<{ value: 'allow' | 'ask' | 'deny'; label: string }>

/** Principal patterns (server policy.model.ts `Principal`). */
export const SUBJECTS = [
  { value: 'node:*', label: 'Any agent' },
  { value: 'central', label: 'Central' },
  { value: 'routine:*', label: 'Any routine' },
  { value: 'telegram:*', label: 'Any Telegram chat' },
  { value: '*', label: 'Anyone' },
]

/** Capability patterns: Claude Code tools and the control-plane verbs (server capability registry). */
export const CAPABILITY_PRESETS: readonly ComboPreset[] = [
  { value: 'claude.tool:Bash', label: 'Run commands' },
  { value: 'claude.tool:Edit', label: 'Edit files' },
  { value: 'claude.tool:Write', label: 'Write files' },
  { value: 'claude.tool:*', label: 'Any Claude Code tool' },
  { value: 'browser.read', label: 'Read web pages' },
  { value: 'browser.act', label: 'Click and type in web pages' },
  { value: 'browser.*', label: 'Any browser action' },
  { value: 'node.prompt', label: 'Send a prompt to a node' },
  { value: 'node.spawn', label: 'Open a node' },
  { value: 'node.close', label: 'Close a node' },
  { value: 'secret.run', label: 'Use a secret' },
  { value: '*', label: 'Anything' },
]

export const SCOPE_PRESETS: readonly ComboPreset[] = [
  { value: '*', label: 'Anywhere' },
  { value: 'npm test*', label: 'Commands starting with npm test' },
  { value: 'git status*', label: 'Commands starting with git status' },
]

/** Capability + scope for "agents may use secret NAME" (server secret.broker.ts: `secret:<NAME>:<command>`). */
export const secretRule = (name: string): { capability: string; scope: string } => ({ capability: 'secret.run', scope: `secret:${name}:*` })

/** Claude Code tool prefix of a capability (server permission.model.ts `TOOL_CAPABILITY_PREFIX`). */
export const TOOL_PREFIX = 'claude.tool:'

const PREFIXES: Array<[string, string]> = [['node:', 'Agent'], ['routine:', 'Routine'], ['telegram:', 'Telegram chat']]

export function whoText(subject: string): string {
  const known = SUBJECTS.find((s) => s.value === subject)
  if (known) return known.label
  const p = PREFIXES.find(([pre]) => subject.startsWith(pre))
  return p ? `${p[1]} ${subject.slice(p[0].length)}` : subject
}

/** Plain words for a capability; an unknown Claude Code tool reads "Use the X tool", other unknowns stay as typed. */
export function whatText(capability: string): string {
  const known = CAPABILITY_PRESETS.find((c) => c.value === capability)?.label
  if (known) return known
  return capability.startsWith(TOOL_PREFIX) ? `Use the ${capability.slice(TOOL_PREFIX.length)} tool` : capability
}

/** The stored patterns, for a tooltip next to the plain words (who / what / where). */
export const rawRuleText = (g: { subject: string; capability: string; scope: string }): string => `${g.subject} · ${g.capability} · ${g.scope}`

/** "anywhere", "NPM_TOKEN, any command", "starting with npm test"; otherwise the pattern itself. */
export function whereText(scope: string): string {
  if (scope === '*') return 'anywhere'
  const secret = /^secret:([^:]+):(.*)$/.exec(scope)
  if (secret) return `${secret[1]}, ${secret[2] === '*' ? 'any command' : startsWith(secret[2] as string)}`
  return startsWith(scope)
}

const startsWith = (p: string): string => (p.endsWith('*') && !p.slice(0, -1).includes('*') ? `starting with ${p.slice(0, -1).trim()}` : p)
