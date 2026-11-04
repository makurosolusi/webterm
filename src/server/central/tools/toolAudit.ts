import { appendEvent } from '../../ledger/ledgerEvent'
import type { ToolCtx, ToolDef, ToolResult } from './toolTypes'

const MAX_NAME = 64
/** Event kind kept from the pre-registry proposal pipeline so existing readers keep working. */
export const TOOL_AUDIT_KIND = 'central.proposal'

/** Appends one audit event for a tool call outcome; only `def.auditKeys` of `data` are copied (never raw input). Returns its ledger seq. */
export function auditTool(ctx: ToolCtx, name: string, def: ToolDef | undefined, projectId: string | undefined, result: ToolResult): number {
  const payload: Record<string, unknown> = { tool: name.slice(0, MAX_NAME), ok: result.ok }
  if (def) payload.tier = def.tier
  if (projectId) payload.projectId = projectId
  for (const key of def?.auditKeys ?? []) {
    const value = result.data?.[key]
    if (value !== undefined && value !== null) payload[key] = value
  }
  if (result.code) payload.code = result.code
  return appendEvent({ db: ctx.db, now: ctx.now }, { kind: TOOL_AUDIT_KIND, actor: 'central', ...(projectId ? { projectId } : {}), payload }).seq
}
