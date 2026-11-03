// Continuation rounds for R0 read tools (RND/29 §4.2 step 5). After a runtime round, `<webterm-proposal>`
// blocks naming R0 tools (or unknown tools) are executed by the server through `execTool`; the redacted
// results are fed to the next round as data. At most `maxSteps` runtime rounds per turn. Write-tier
// blocks stop the loop untouched so the proposal pipeline still sees them.
import type { Database } from 'bun:sqlite'
import { flagOn } from '../../envFlag'
import { type ProposalBlock, parseProposals } from '../proposal/proposalParser'
import { READ_TOOLS_FLAG, clip } from '../tools/defs/read.shared'
import { ALLOW_ALL_GUARD, execTool } from '../tools/toolExec'
import type { ControlGuard, ToolCtx, ToolRegistry } from '../tools/toolTypes'
import {
  type CentralRuntime, type RuntimeEmit, type RuntimeEvent, type RuntimeResult, type RuntimeUsage,
  type TurnInput, zeroUsage,
} from '../runtime/centralRuntime'
import { formatToolResult, wrapToolResults } from './toolLoopWrap'
import { redactValue } from '../../redactSecrets'

export const MAX_STEPS_FLAG = 'WEBTERM_CENTRAL_MAX_STEPS'
export const DEFAULT_MAX_STEPS = 2
const MAX_STEPS_CEILING = 10
const ORIGINAL_REQUEST_CHARS = 2000

export interface ToolLoopDeps {
  runtime: CentralRuntime
  db: Database
  registry: ToolRegistry
  guard?: ControlGuard
  conversationId: string
  env: NodeJS.ProcessEnv
  now: () => number
  /** True once the turn was closed elsewhere (cancel); the loop then returns without another round. */
  stopped?: () => boolean
}

/** True when the read tools and continuation loop are enabled (`WEBTERM_CENTRAL_READ_TOOLS=on`). */
export function readToolsEnabled(env: NodeJS.ProcessEnv): boolean { return flagOn(env[READ_TOOLS_FLAG]) }

/** Max runtime rounds per turn from env: integer 1..10, anything else keeps the default 2. */
export function resolveMaxSteps(env: NodeJS.ProcessEnv): number {
  const raw = (env[MAX_STEPS_FLAG] ?? '').trim()
  const value = /^\d+$/.test(raw) ? Number(raw) : 0
  return value >= 1 && value <= MAX_STEPS_CEILING ? value : DEFAULT_MAX_STEPS
}

/** True for a block naming a registered R0 tool; the proposal pipeline skips these when the loop is on. */
export function isReadBlock(registry: ToolRegistry, block: ProposalBlock): boolean {
  return registry.get(block.tool)?.tier === 'R0'
}

/** Blocks the loop answers itself (R0 or unknown); null when a write-tier block means "leave it to proposals". */
function loopCalls(registry: ToolRegistry, text: string): ProposalBlock[] | null {
  const blocks = parseProposals(text)
  if (blocks.some((b) => registry.get(b.tool) && !isReadBlock(registry, b))) return null
  return blocks
}

function addUsage(a: RuntimeUsage, b: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costMicros: a.costMicros + b.costMicros, durationMs: a.durationMs + b.durationMs,
  }
}

/** Runs the turn, then up to `maxSteps - 1` continuation rounds that carry server-run R0 tool results. */
export async function runToolLoop(
  deps: ToolLoopDeps, input: TurnInput, emit: RuntimeEmit, maxSteps: number
): Promise<RuntimeResult> {
  const startedAt = deps.now()
  const ctx: ToolCtx = {
    db: deps.db, registry: deps.registry, guard: deps.guard ?? ALLOW_ALL_GUARD, maxTier: 'R0',
    conversationId: deps.conversationId, now: deps.now, env: deps.env,
  }
  let seq = 0
  const send = (event: RuntimeEvent): void => emit({ ...event, seq: ++seq })
  let usage = zeroUsage()
  let sessionRef = input.sessionRef ?? null
  let current = input
  for (let step = 1; ; step++) {
    // One monotonic seq across rounds; tool-call ids from later rounds get a prefix so they cannot collide.
    const forward = (event: RuntimeEvent): void => {
      send('toolCallId' in event && step > 1 ? { ...event, toolCallId: `s${step}:${event.toolCallId}` } : event)
    }
    const result = await deps.runtime.turn(current, forward)
    usage = addUsage(usage, result.usage)
    sessionRef = result.sessionRef ?? sessionRef
    const merged: RuntimeResult = { ...result, usage, sessionRef }
    if (result.outcome !== 'success' || step >= maxSteps || deps.stopped?.()) return merged
    const remainingMs = input.limits.maxWallMs === undefined ? undefined : input.limits.maxWallMs - (deps.now() - startedAt)
    if (remainingMs !== undefined && remainingMs <= 0) return merged
    const calls = loopCalls(deps.registry, result.text)
    if (!calls || calls.length === 0) return merged

    const lines: string[] = []
    for (const [index, call] of calls.entries()) {
      const toolCallId = `${input.turnId}:read:${step}:${index + 1}`
      const base = { turnId: input.turnId, at: deps.now() }
      send({ ...base, seq: 0, type: 'tool.requested', toolCallId, name: clip(call.tool, 64), input: redactValue(call.input) })
      const t0 = deps.now()
      const outcome = await execTool(ctx, call.tool, call.input)
      send({
        ...base, seq: 0, type: 'tool.completed', toolCallId, name: clip(call.tool, 64), ok: outcome.ok,
        ...(outcome.code ? { errorCode: outcome.code } : {}), output: redactValue(outcome.data), durationMs: Math.max(0, deps.now() - t0),
      })
      lines.push(formatToolResult(call.tool, outcome))
    }
    const last = step + 1 >= maxSteps
    const header = sessionRef ? '' : `Original request:\n${clip(input.text, ORIGINAL_REQUEST_CHARS)}\n\n`
    const footer = last ? 'Answer the human now using these results; no more tool calls.' : 'Use these results to answer; you may call one more read tool.'
    current = {
      ...input, text: `${header}${wrapToolResults(lines)}\n${footer}`, ...(sessionRef ? { sessionRef } : {}),
      limits: remainingMs === undefined ? input.limits : { ...input.limits, maxWallMs: remainingMs },
    }
  }
}
