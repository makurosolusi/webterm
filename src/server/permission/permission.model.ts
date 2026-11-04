// Claude Code `PermissionRequest` / `PreToolUse` reply shapes and the pure helpers around them
// (F3-b). No I/O, no bun:sqlite: vitest-safe.
//
// Contract (code.claude.com/docs/en/hooks, "PermissionRequest" > Decision control):
//   { hookSpecificOutput: { hookEventName: 'PermissionRequest',
//       decision: { behavior: 'allow' | 'deny', updatedInput?, updatedPermissions?, message?, interrupt? } } }
// `message` is for deny only. Returning NO decision leaves the permission flow unchanged, so Claude
// shows its own prompt in the terminal; that is the timeout path here.
// PreToolUse blocks with `hookSpecificOutput.permissionDecision: 'deny'` + `permissionDecisionReason`
// (the reason is shown to Claude).
// Doom loop: imitates OpenCode's `doom_loop` permission (opencode.ai/docs/permissions): the same tool
// call with identical input three times in a row is treated as a loop.
import { redactSecrets } from '../redactSecrets'

/** Ledger approval kind of a Claude permission prompt. */
export const PERMISSION_KIND = 'agent.permission'
/** Approval id prefix, so the inbox can render these rows with their own buttons. */
export const PERMISSION_ID_PREFIX = 'perm_'
/** Capability namespace of a tool grant: `claude.tool:<ToolName>`; scope = resource pattern. */
export const TOOL_CAPABILITY_PREFIX = 'claude.tool:'
/** Identical consecutive PreToolUse calls that count as a loop (OpenCode doom_loop). */
export const DOOM_LOOP_REPEATS = 3
/** Calls further apart than this never count as the same loop. */
export const DOOM_LOOP_WINDOW_MS = 60_000

const PREVIEW_MAX = 120
const RESOURCE_MAX = 2000

export type Behavior = 'allow' | 'deny'

export interface PermissionBody {
  hook_event_name?: string
  tool_name?: unknown
  tool_input?: unknown
  agent_id?: unknown
  permission_suggestions?: unknown
}

export interface PermissionOutput {
  hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: Behavior; message?: string } }
}

/** The documented decision object; `message` only travels with a deny. */
export function permissionDecision(behavior: Behavior, message?: string): PermissionOutput {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...(behavior === 'deny' && message ? { message } : {}) } } }
}

/** PreToolUse block reply; the reason is what Claude reads. */
export function preToolDeny(reason: string): { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } {
  return { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function toolName(body: PermissionBody): string {
  const name = str(body.tool_name)
  return /^[\w.:-]{1,128}$/.test(name) ? name : 'tool'
}

/** The part of a tool's input a grant is matched against: command, path or URL; '' when none. */
export function toolResource(body: PermissionBody): string {
  const input = (body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {}) as Record<string, unknown>
  const raw = str(input.command) || str(input.file_path) || str(input.notebook_path) || str(input.path) || str(input.url) || str(input.pattern)
  return raw.slice(0, RESOURCE_MAX)
}

/** One-line, secret-scrubbed, capped preview (Rule 7/12): never the full tool input. */
export function preview(text: string, max = PREVIEW_MAX): string {
  const flat = redactSecrets(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** `Bash(npm publish)`, or the bare tool name when the input has no resource. */
export function toolLabel(body: PermissionBody): string {
  const resource = toolResource(body)
  return resource ? `${toolName(body)}(${preview(resource)})` : toolName(body)
}

/**
 * Scope pattern for "Always allow this pattern". Claude's own `permission_suggestions` rule for this
 * tool wins (its `cmd:*` prefix rule becomes our `cmd*` wildcard); else the exact resource; else `*`
 * for a tool without one. Null when the resource itself holds `*`/`?`: the policy matcher has no
 * escape, so the grant would allow more than the human saw (`rm *` would match `rm -rf /`).
 */
export function suggestedPattern(body: PermissionBody): string | null {
  const tool = toolName(body)
  const suggestions = Array.isArray(body.permission_suggestions) ? body.permission_suggestions : []
  for (const s of suggestions as Array<Record<string, unknown>>) {
    if (s?.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules)) continue
    for (const r of s.rules as Array<Record<string, unknown>>) {
      const content = str(r?.ruleContent)
      if (r?.toolName === tool && content && content.length <= 200) return content.replace(/:\*$/, '*')
    }
  }
  const resource = toolResource(body)
  if (!resource) return '*'
  return resource.length <= 200 && !/[*?]/.test(resource) ? resource : null
}

/** Consecutive identical-call counter per node (and per subagent). In-memory on purpose. */
export function createDoomLoopGuard(repeats = DOOM_LOOP_REPEATS, windowMs = DOOM_LOOP_WINDOW_MS) {
  // ponytail: one entry per node/agent, never evicted; bounded by the number of nodes ever run.
  const last = new Map<string, { key: string; count: number; at: number }>()
  return {
    /** Records a PreToolUse call; returns the repeat count when it reached the loop threshold, else 0. */
    check(nodeId: string, body: PermissionBody, now: number): number {
      const who = `${nodeId}|${str(body.agent_id)}`
      let input: string
      try { input = JSON.stringify(body.tool_input ?? null) } catch { input = '?' }
      const key = `${toolName(body)}|${input}`
      const prev = last.get(who)
      const count = prev && prev.key === key && now - prev.at <= windowMs ? prev.count + 1 : 1
      last.set(who, { key, count, at: now })
      return count >= repeats ? count : 0
    },
  }
}

/** Reason Claude reads when the doom-loop guard blocks a call. */
export function doomLoopReason(label: string, count: number): string {
  return `webterm blocked this call: ${label} was requested ${count} times in a row with identical input. ` +
    'This looks like a loop. Change your approach or ask the user instead of repeating the same call.'
}
