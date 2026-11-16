// Local tool contracts. `Tier` is the frozen contract type. `ControlGuard`/`ToolCtx` stay local on purpose:
// the contract guard is async and keyed by action, while `execTool` needs the synchronous gate;
// `toToolGuard` (guard/controlGuard.ts) is the one bridge between them, so the two shapes cannot drift.
import type { Database } from 'bun:sqlite'
import { flagOn } from '../../envFlag'
import type { JsonSchema } from '../../capability/capability.schema'
import type { Tier } from '../contracts/level.types'

export type { Tier }
export const TIER_ORDER: readonly Tier[] = ['R0', 'R1', 'R2', 'R3']
/** True when `tier` does not exceed `max`. */
export function tierWithin(tier: Tier, max: Tier): boolean { return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(max) }

/** Validation failures shared by proposal policy and `execTool`. */
export type ToolValidationCode = 'forbidden_key' | 'project_required' | 'project_not_found' | 'conversation_project_mismatch' | 'invalid_shape' | 'task_not_found'
/** Every code `execTool` can return itself, on top of handler-specific codes. */
export type ToolCode = ToolValidationCode | 'unknown_tool' | 'flag_off' | 'tier_denied' | 'guard_denied'

export interface GuardRequest { tool: string; tier: Tier; projectId?: string; input: Record<string, unknown>; conversationId?: string }
export type GuardVerdict = { ok: true } | { ok: false; code: string }
/** Port to the server-side control guard (level, budget, breaker); injected, mocked in tests. */
export interface ControlGuard {
  check(request: GuardRequest): GuardVerdict
  /** Settings > Skip approvals is on for this caller; handlers with their own card skip it. */
  skipsApprovals?(projectId?: string | null): boolean
}

export type ToolInput = Record<string, unknown>
/** Handler outcome; `data` is returned to the caller and (whitelisted by `auditKeys`) audited. */
export interface ToolResult { ok: boolean; code?: string; data?: Record<string, unknown> }
export interface ExecResult extends ToolResult { tool: string; projectId?: string }

export interface ToolCtx {
  db: Database
  registry: ToolRegistry
  guard: ControlGuard
  /** Highest tier this caller may execute. */
  maxTier: Tier
  conversationId: string
  /** Turn that issued this call, when it runs inside a real Central turn. */
  turnId?: string
  now(): number
  /** Flag source; defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

export interface ToolDef {
  name: string
  /** One-line description, at most 120 chars. */
  summary: string
  tier: Tier
  /** Exact input schema text rendered into the prompt catalog. */
  usage: string
  /**
   * JSON Schema of the input, WITHOUT `projectId` (added for project-scoped tools by `toolCapability`).
   * Checked by `validateToolInput` before `validate`. Optional only for test-local stand-ins; every
   * production def declares it (capability.drift.test.ts).
   */
  input?: JsonSchema
  /** JSON Schema of `data` on success. */
  output?: JsonSchema
  /** Env flag name that must be `on` for the tool to exist; absent = always on. */
  flag?: string
  /** Custom env reader that replaces `flag` (e.g. a default-on flag shared with another subsystem). */
  enabled?(env: Record<string, string | undefined>): boolean
  /** Defaults to true: input carries a `projectId` that must exist and match the conversation. */
  projectScoped?: boolean
  /** Overrides the default deep forbidden-key scan. */
  forbidden?(input: ToolInput): boolean
  /** Shape and tool-specific checks; returns a failure code or null. */
  validate(input: ToolInput, ctx: ToolCtx): ToolValidationCode | null
  handler(ctx: ToolCtx, input: ToolInput, projectId: string | undefined): Promise<ToolResult> | ToolResult
  /** `data` keys copied into the audit event. */
  auditKeys?: readonly string[]
}

/** True when the def's env gate is open: `enabled` reader if set, else `flag` must be `on`, else always on. */
export function defEnabled(def: ToolDef, env: Record<string, string | undefined>): boolean {
  return def.enabled ? def.enabled(env) : !def.flag || flagOn(env[def.flag])
}

export interface ToolRegistry {
  /** Adds a tool; throws on a duplicate name. */
  register(def: ToolDef): void
  list(): ToolDef[]
  get(name: string): ToolDef | undefined
}
