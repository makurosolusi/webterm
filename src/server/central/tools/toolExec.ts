import { flagOn } from '../../envFlag'
import { auditTool } from './toolAudit'
import { type ControlGuard, type ExecResult, type ToolCtx, type ToolDef, type ToolInput, type ToolResult, tierWithin } from './toolTypes'
import { validateToolInput } from './toolValidate'

/** Guard that permits everything, for callers whose gating happened upstream (proposal pipeline). */
export const ALLOW_ALL_GUARD: ControlGuard = { check: () => ({ ok: true }) }

export interface ExecOptions { /** Input already passed `validateToolInput` (proposal pipeline); skips re-validation. */ prevalidated?: boolean }

/** Single execution gate: flag, validate, tier, guard, handler, audit. Every outcome is audited. */
export async function execTool(ctx: ToolCtx, name: string, args: ToolInput, options: ExecOptions = {}): Promise<ExecResult> {
  const def = ctx.registry.get(name)
  // Only a validated project id may reach the audit event (it is a ledger reference).
  const trusted = options.prevalidated && typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim() : undefined
  const finish = (result: ToolResult, projectId = trusted): ExecResult => {
    auditTool(ctx, name, def, projectId, result)
    return { ...result, tool: name, ...(projectId ? { projectId } : {}) }
  }
  if (!def) return finish({ ok: false, code: 'unknown_tool' })
  if (def.flag && !flagOn((ctx.env ?? process.env)[def.flag])) return finish({ ok: false, code: 'flag_off' })
  let projectId = trusted
  if (!options.prevalidated) {
    const checked = validateToolInput(def, args, ctx)
    if (!checked.ok) return finish({ ok: false, code: checked.code })
    projectId = checked.projectId
  }
  if (!tierWithin(def.tier, ctx.maxTier)) return finish({ ok: false, code: 'tier_denied' }, projectId)
  const verdict = ctx.guard.check({ tool: name, tier: def.tier, ...(projectId ? { projectId } : {}), input: args })
  if (!verdict.ok) return finish({ ok: false, code: verdict.code || 'guard_denied' }, projectId)
  return finish(await runHandler(def, ctx, args, projectId), projectId)
}

async function runHandler(def: ToolDef, ctx: ToolCtx, args: ToolInput, projectId: string | undefined): Promise<ToolResult> {
  try {
    return await def.handler(ctx, args, projectId)
  } catch (err) {
    // The error becomes a coded, audited result (message dropped: it may echo input); nothing is swallowed.
    return { ok: false, code: err instanceof Error && 'code' in err ? String((err as Error & { code: unknown }).code) : 'invalid_proposal' }
  }
}
