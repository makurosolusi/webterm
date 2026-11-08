// Shared vocabulary of Settings › Rules & approvals: the Who/What/Where choices offered when making or
// trying a rule (PolicyRules, PolicySimulator) and the plain-words reading of a stored rule's patterns.
import type { ComboPreset } from './SettingsCombobox'

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

/** Window event a panel fires to pre-fill the add-rule row of PolicyRules. */
export const PREFILL_RULE_EVENT = 'webterm:prefill-rule'
export interface PrefillRule { capability: string; scope: string }
export const prefillRule = (detail: PrefillRule): void => { window.dispatchEvent(new CustomEvent(PREFILL_RULE_EVENT, { detail })) }

/** Capability + scope for "this agent may use secret NAME" (server secret.broker.ts: `secret:<NAME>:<command>`). */
export const secretRule = (name: string): PrefillRule => ({ capability: 'secret.run', scope: `secret:${name}:*` })

const PREFIXES: Array<[string, string]> = [['node:', 'Agent'], ['routine:', 'Routine'], ['telegram:', 'Telegram chat']]

export function whoText(subject: string): string {
  const known = SUBJECTS.find((s) => s.value === subject)
  if (known) return known.label
  const p = PREFIXES.find(([pre]) => subject.startsWith(pre))
  return p ? `${p[1]} ${subject.slice(p[0].length)}` : subject
}

export function whatText(capability: string): string {
  return CAPABILITY_PRESETS.find((c) => c.value === capability)?.label ?? capability
}

/** "anywhere", "NPM_TOKEN, any command", "starting with npm test"; otherwise the pattern itself. */
export function whereText(scope: string): string {
  if (scope === '*') return 'anywhere'
  const secret = /^secret:([^:]+):(.*)$/.exec(scope)
  if (secret) return `${secret[1]}, ${secret[2] === '*' ? 'any command' : startsWith(secret[2] as string)}`
  return startsWith(scope)
}

const startsWith = (p: string): string => (p.endsWith('*') && !p.slice(0, -1).includes('*') ? `starting with ${p.slice(0, -1).trim()}` : p)
