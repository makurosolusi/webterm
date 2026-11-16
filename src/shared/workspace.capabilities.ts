// What each harness can do, and how a custom agent borrows those abilities.
// Facts about the Claude Code CLI (`--resume`, `--session-id`, `--permission-mode`, `--model`,
// `--settings`) come from https://code.claude.com/docs/en/cli-reference.
import { agentConfig, type AgentId, type BuiltinAgentId } from './workspace.agents'

// ---------------------------------------------------------------------------------------------
// Inheritance: a custom agent may declare `baseAgent` (a builtin) to reuse that harness's
// abilities, e.g. a claude wrapper that points at its own inference proxy but should keep
// resume, context link and hook integration. Without a base a custom agent has no abilities.
//
// This module cannot import `settings.ts` (settings imports AgentId from here), so the
// custom-id -> base lookup is injected: client and server each register a resolver at init.
type BaseResolver = (id: AgentId) => BuiltinAgentId | undefined
let resolveCustomBase: BaseResolver | null = null

/** Register the custom-id -> baseAgent lookup (once per runtime); pass `null` to clear it (tests). */
export function setCustomAgentBaseResolver(fn: BaseResolver | null): void {
  resolveCustomBase = fn
}

/**
 * The builtin harness a custom agent inherits, or undefined for builtins and for custom agents
 * without a base. Builtins never go through the registry (they ARE the harness), so a custom id
 * that collides with a builtin name still resolves as that builtin.
 */
export function baseAgentOf(id: AgentId): BuiltinAgentId | undefined {
  if (!resolveCustomBase || agentConfig(id)) return undefined
  return resolveCustomBase(id)
}

/** The id whose abilities apply to `id`: its base harness when inherited, otherwise itself. */
export function capabilityAgentId(id: AgentId): AgentId {
  return baseAgentOf(id) ?? id
}

// ---------------------------------------------------------------------------------------------
// One membership list per ability. Claude Code is the only first-class harness, so each list is
// `['claude']`; a CLI that gains an ability later is added to that ability's list only.
// Inheritance (above) applies to every predicate through `capabilityAgentId`.

/** Can continue a conversation from a session id (`--resume`). */
export const RESUMABLE_AGENTS: readonly BuiltinAgentId[] = ['claude']

/** The session id is minted by us at launch (`--session-id <uuid>`) instead of learned from hook events,
 *  so a node always holds a resumable id: worst case drops from "conversation lost" to "history since last /clear lost". */
export const SESSION_ID_CAPABLE: readonly BuiltinAgentId[] = ['claude']

/** Can read linked nodes through the `get-linked-context` skill. */
export const CONTEXT_LINK_CAPABLE: readonly BuiltinAgentId[] = ['claude']

/** Per-node context meter can be filled; needs both tokens used and a trustworthy window size. */
export const USAGE_CAPABLE: readonly BuiltinAgentId[] = ['claude']

/** Accepts a permission mode at launch (`--permission-mode`). */
export const PERMISSION_MODE_CAPABLE: readonly BuiltinAgentId[] = ['claude']

/** Accepts a per-launch model override (`--model`). */
export const MODEL_SWITCH_CAPABLE: readonly BuiltinAgentId[] = ['claude']

/** Takes webterm hook config inline through Claude Code's `--settings` flag (see `claudeHooksSettings`
 *  in src/server/hooks.ts). Another CLI may join only if it really understands that flag and JSON shape. */
export const CLAUDE_HOOK_SETTINGS_CAPABLE: readonly BuiltinAgentId[] = ['claude']

const listed = (list: readonly string[], id: AgentId): boolean => list.includes(capabilityAgentId(id))

export const canResume = (id: AgentId): boolean => listed(RESUMABLE_AGENTS, id)
export const mintsSessionId = (id: AgentId): boolean => listed(SESSION_ID_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => listed(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => listed(USAGE_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => listed(PERMISSION_MODE_CAPABLE, id)
export const canSwitchModel = (id: AgentId): boolean => listed(MODEL_SWITCH_CAPABLE, id)
/** Does `id`'s launch line carry hook config via `--settings`? Inheritance-aware. */
export const hasClaudeHookSettings = (id: AgentId): boolean => listed(CLAUDE_HOOK_SETTINGS_CAPABLE, id)

/** Permission mode a session starts in; the user can still cycle it at runtime (Shift+Tab).
 *  `manual` is sent as `--permission-mode default`. */
export type AgentPermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

const PERMISSION_MODES: ReadonlySet<string> = new Set<AgentPermissionMode>([
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'bypassPermissions',
])

/** Re-validate at the point of use: the value lands on a shell command line, and settings can be hand-edited or arrive over HTTP. */
export const isPermissionMode = (v: unknown): v is AgentPermissionMode =>
  typeof v === 'string' && PERMISSION_MODES.has(v)
