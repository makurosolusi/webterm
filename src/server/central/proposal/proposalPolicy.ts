import type { Database } from 'bun:sqlite'
import { getRow } from '../../ledger/ledgerCore'
import type { ProposalBlock } from './proposalParser'

export type ProposalCode = 'planner_off' | 'tools_read_only' | 'forbidden_key' | 'unknown_tool' | 'project_required' | 'project_not_found' | 'conversation_project_mismatch' | 'invalid_shape' | 'task_not_found'
export interface PolicyInput { planner: boolean; toolsWrite: boolean; conversationId: string; db: Database }
export interface ValidProposal extends ProposalBlock { projectId: string }
export interface PolicyResult { ok: boolean; code?: ProposalCode; proposal?: ValidProposal }
const ALLOWED = new Set(['goal.propose', 'plan.propose', 'task.assign', 'approval.request'])
const FORBIDDEN = new Set(['actor', 'authority', 'status', 'role', 'path', 'repo', 'command', 'cmd', 'cwd', 'capability', 'token', 'decision', 'approvedBy', 'nonce', 'digest'])
const APPROVAL_NESTED_FORBIDDEN = new Set(['actor', 'authority', 'capability', 'token', 'nonce', 'digest', 'decision', 'approvedBy'])
const SAFE_ID = /^[A-Za-z0-9._:-]+$/

function containsForbidden(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsForbidden)
  return Object.entries(value).some(([key, child]) => FORBIDDEN.has(key) || containsForbidden(child))
}
function shape(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'goal.propose') return typeof input.statement === 'string' && Array.isArray(input.successCriteria) && typeof input.owner === 'string' && typeof input.horizon === 'string' && !!input.envelope && typeof input.envelope === 'object'
  if (tool === 'plan.propose') return Array.isArray(input.items) && input.items.every((item) => item && typeof item === 'object' && typeof item.title === 'string' && Array.isArray(item.scope))
  if (tool === 'task.assign') return typeof input.itemId === 'string' && input.itemId.trim().length > 0 && Number.isSafeInteger(input.expectedVersion) && (input.expectedVersion as number) >= 1 && (input.assignee === undefined || (typeof input.assignee === 'string' && input.assignee.length <= 200 && !/[\s\p{Cc}]/u.test(input.assignee)))
  if (tool === 'approval.request') {
    const requestId = input.requestId
    const kind = input.kind
    const request = input.request
    const taskId = input.taskId
    return typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= 200 && SAFE_ID.test(requestId)
      && typeof kind === 'string' && kind.length >= 1 && kind.length <= 100 && SAFE_ID.test(kind)
      && !!request && typeof request === 'object' && !Array.isArray(request)
      && JSON.stringify(request).length <= 8 * 1024
      && (taskId === undefined || (typeof taskId === 'string' && taskId.length <= 200 && SAFE_ID.test(taskId)))
  }
  return false
}
export function validateProposal(block: ProposalBlock, policy: PolicyInput): PolicyResult {
  if (!policy.planner) return { ok: false, code: 'planner_off' }
  if (!policy.toolsWrite) return { ok: false, code: 'tools_read_only' }
  if (!ALLOWED.has(block.tool)) return { ok: false, code: 'unknown_tool' }
  if (block.tool === 'approval.request') {
    const topLevel = Object.keys(block.input).some((key) => FORBIDDEN.has(key))
    const request = block.input.request
    const nested = request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).some((key) => APPROVAL_NESTED_FORBIDDEN.has(key))
    if (topLevel || nested) return { ok: false, code: 'forbidden_key' }
  } else if (containsForbidden(block.input)) return { ok: false, code: 'forbidden_key' }
  const projectId = typeof block.input.projectId === 'string' ? block.input.projectId.trim() : ''
  if (!projectId) return { ok: false, code: 'project_required' }
  if (getRow(policy.db, 'SELECT 1 AS one FROM project WHERE id = ?', projectId) === null) return { ok: false, code: 'project_not_found' }
  if (policy.conversationId.startsWith('central:project:') && policy.conversationId.slice('central:project:'.length) !== projectId) return { ok: false, code: 'conversation_project_mismatch' }
  if (!shape(block.tool, block.input)) return { ok: false, code: 'invalid_shape' }
  if (block.tool === 'approval.request' && typeof block.input.taskId === 'string' && getRow(policy.db, 'SELECT 1 AS one FROM task WHERE id = ?', block.input.taskId) === null) return { ok: false, code: 'task_not_found' }
  return { ok: true, proposal: { ...block, projectId } }
}
