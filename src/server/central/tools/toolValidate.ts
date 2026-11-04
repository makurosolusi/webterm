import { checkSchema } from '../../capability/capability.schema'
import { getRow } from '../../ledger/ledgerCore'
import type { ToolCtx, ToolDef, ToolInput, ToolValidationCode } from './toolTypes'

export const FORBIDDEN_KEYS = new Set(['actor', 'authority', 'status', 'role', 'path', 'repo', 'command', 'cmd', 'cwd', 'capability', 'token', 'decision', 'approvedBy', 'nonce', 'digest'])
export const APPROVAL_NESTED_FORBIDDEN = new Set(['actor', 'authority', 'capability', 'token', 'nonce', 'digest', 'decision', 'approvedBy'])
const PROJECT_CONVERSATION_PREFIX = 'central:project:'

/** Deep scan for keys the model may never set (I1/I3/I4). */
export function containsForbidden(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsForbidden)
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbidden(child))
}

export type ToolValidation = { ok: true; projectId: string | undefined } | { ok: false; code: ToolValidationCode }

/** Runs forbidden-key, project and tool-specific checks, in that order. */
export function validateToolInput(def: ToolDef, input: ToolInput, ctx: ToolCtx): ToolValidation {
  if ((def.forbidden ?? containsForbidden)(input)) return { ok: false, code: 'forbidden_key' }
  let projectId: string | undefined
  if (def.projectScoped !== false) {
    projectId = typeof input.projectId === 'string' ? input.projectId.trim() : ''
    if (!projectId) return { ok: false, code: 'project_required' }
    if (getRow(ctx.db, 'SELECT 1 AS one FROM project WHERE id = ?', projectId) === null) return { ok: false, code: 'project_not_found' }
    if (ctx.conversationId.startsWith(PROJECT_CONVERSATION_PREFIX) && ctx.conversationId.slice(PROJECT_CONVERSATION_PREFIX.length) !== projectId) return { ok: false, code: 'conversation_project_mismatch' }
  }
  // The declared JSON Schema is enforced, not just documented; `validate` then adds the checks a schema cannot express.
  if (def.input && checkSchema(def.input, input) !== null) return { ok: false, code: 'invalid_shape' }
  const code = def.validate(input, ctx)
  return code ? { ok: false, code } : { ok: true, projectId }
}
