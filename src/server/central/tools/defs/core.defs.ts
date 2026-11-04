import type { Database } from 'bun:sqlite'
import { isEnabled } from '../../../featureCapabilities.runtime'
import { type LedgerContext, getRow } from '../../../ledger/ledgerCore'
import { approvalDigest, getApproval, requestApproval } from '../../../ledger/ledgerApproval'
import { createPlanStore } from '../../../orchestrator/plan'
import { assignControl } from '../../../orchestratorControlService'
import { proposeGoal } from '../../goalStore'
import type { ToolDef, ToolInput, ToolResult } from '../toolTypes'
import { APPROVAL_NESTED_FORBIDDEN, FORBIDDEN_KEYS } from '../toolValidate'
import { obj, S } from '../../../capability/capability.schema'

const SAFE_ID = /^[A-Za-z0-9._:-]+$/
const MAX_REQUEST_BYTES = 8 * 1024
const MAX_ID = 200
const MAX_KIND = 100
const AUDIT_KEYS = ['approvalId', 'taskId', 'goalVersion', 'planVersion'] as const

function ledgerCtx(db: Database): LedgerContext { return { db, now: () => Date.now() } }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

const approvalRequest: ToolDef = {
  name: 'approval.request',
  summary: 'Create a pending human approval for a request; never decides or runs it.',
  tier: 'R1',
  usage: '{"projectId":"<id>","requestId":"<safe id>","kind":"<safe id>","request":{}}. taskId is optional, must be an existing task id, never a plan item id, and should be omitted unless asked. It creates a pending approval for a human and never decides or runs.',
  input: obj({ requestId: S.str(MAX_ID), kind: S.str(MAX_KIND), request: S.anyObj(), taskId: S.str(MAX_ID) }, ['requestId', 'kind', 'request']),
  output: S.keys('approvalId', 'expiresAt', 'reused'),
  auditKeys: AUDIT_KEYS,
  forbidden(input) {
    const nested = isRecord(input.request) && Object.keys(input.request).some((key) => APPROVAL_NESTED_FORBIDDEN.has(key))
    return Object.keys(input).some((key) => FORBIDDEN_KEYS.has(key)) || nested
  },
  validate(input, ctx) {
    const { requestId, kind, request, taskId } = input
    const ok = typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= MAX_ID && SAFE_ID.test(requestId)
      && typeof kind === 'string' && kind.length >= 1 && kind.length <= MAX_KIND && SAFE_ID.test(kind)
      && isRecord(request) && JSON.stringify(request).length <= MAX_REQUEST_BYTES
      && (taskId === undefined || (typeof taskId === 'string' && taskId.length <= MAX_ID && SAFE_ID.test(taskId)))
    if (!ok) return 'invalid_shape'
    return typeof taskId === 'string' && getRow(ctx.db, 'SELECT 1 AS one FROM task WHERE id = ?', taskId) === null ? 'task_not_found' : null
  },
  handler(ctx, input, projectId): ToolResult {
    const lc = ledgerCtx(ctx.db)
    const approvalId = `central-${String(input.requestId)}`
    const existing = getApproval(lc, approvalId)
    if (typeof input.taskId === 'string' && existing === null && getRow(ctx.db, 'SELECT 1 AS one FROM task WHERE id = ?', input.taskId) === null) return { ok: false, code: 'task_not_found' }
    if (existing) {
      const same = existing.projectId === projectId && existing.kind === input.kind && existing.taskId === (input.taskId ?? null) && approvalDigest(existing.request) === approvalDigest(input.request)
      return same ? { ok: true, data: { approvalId, expiresAt: existing.expiresAt ?? undefined, reused: true } } : { ok: false, code: 'request_conflict' }
    }
    try {
      const challenge = requestApproval(lc, { id: approvalId, projectId: projectId as string, kind: String(input.kind), request: input.request, ...(input.taskId ? { taskId: String(input.taskId) } : {}) })
      return { ok: true, data: { approvalId: challenge.id, expiresAt: challenge.expiresAt } }
    } catch {
      // requestApproval throws on rejected content; surface only a coded failure, never the request body.
      return { ok: false, code: 'invalid_request' }
    }
  },
}

const goalPropose: ToolDef = {
  name: 'goal.propose',
  summary: 'Propose a project goal with success criteria and a cost/time envelope.',
  tier: 'R1',
  usage: '{"projectId":"<id>","statement":"<=500 chars","successCriteria":[{"kind":"review","by":"human"}],"owner":"human:<name>","horizon":"YYYY-MM-DD","envelope":{"maxCostMicros":1000000,"maxWallMs":600000,"maxItems":3}}; successCriteria entries MUST be objects with kind command|scope|review, and review requires by:"human"; use no title/description fields.',
  input: obj({ statement: S.str(), successCriteria: { type: 'array' }, owner: S.str(), horizon: S.str(), envelope: S.anyObj(), expectedVersion: S.any() }, ['statement', 'successCriteria', 'owner', 'horizon', 'envelope']),
  output: S.keys('goalVersion'),
  auditKeys: AUDIT_KEYS,
  validate: (input) => (typeof input.statement === 'string' && Array.isArray(input.successCriteria) && typeof input.owner === 'string' && typeof input.horizon === 'string' && !!input.envelope && typeof input.envelope === 'object' ? null : 'invalid_shape'),
  handler(ctx, input, projectId): ToolResult {
    const goal = proposeGoal(ctx.db, { projectId: projectId as string, draft: input as never, actor: { id: 'central', kind: 'central' }, expectedVersion: input.expectedVersion as number | null | undefined })
    return { ok: true, data: { goalVersion: goal.version } }
  },
}

const planPropose: ToolDef = {
  name: 'plan.propose',
  summary: 'Propose a draft plan: ordered items with titles and relative-path scopes.',
  tier: 'R1',
  usage: '{"projectId":"<id>","items":[{"title":"...","scope":["relative/path"]}],"expectedVersion":<current version or omit>}.',
  input: obj({ items: S.arr(obj({ title: S.str(), scope: { type: 'array' } }, ['title', 'scope'])), expectedVersion: S.any() }, ['items']),
  output: S.keys('planVersion'),
  auditKeys: AUDIT_KEYS,
  validate: (input) => (Array.isArray(input.items) && input.items.every((item) => item && typeof item === 'object' && typeof item.title === 'string' && Array.isArray(item.scope)) ? null : 'invalid_shape'),
  handler(ctx, input, projectId): ToolResult {
    const plans = createPlanStore(ctx.db)
    const current = plans.get(projectId as string)
    const base = { projectId: projectId as string, items: input.items as never[] }
    const plan = current
      ? plans.replace({ ...base, expectedVersion: (input.expectedVersion as number | undefined) ?? current.version, status: 'draft' } as never)
      : plans.create({ ...base, status: 'draft' } as never)
    return { ok: true, data: { planVersion: plan.version } }
  },
}

function assignShape(input: ToolInput): boolean {
  const assignee = input.assignee
  return typeof input.itemId === 'string' && input.itemId.trim().length > 0 && Number.isSafeInteger(input.expectedVersion) && (input.expectedVersion as number) >= 1
    && (assignee === undefined || (typeof assignee === 'string' && assignee.length <= MAX_ID && !/[\s\p{Cc}]/u.test(assignee)))
}
const taskAssign: ToolDef = {
  name: 'task.assign',
  summary: 'Create a task for an existing pending plan item; does not run or approve.',
  tier: 'R1',
  usage: '{"projectId":"<id>","itemId":"<existing pending item>","expectedVersion":<plan version>}. Assign only creates a task for an existing pending plan item. It does not run, spawn, or approve.',
  input: obj({ itemId: S.str(), expectedVersion: S.int(1), assignee: S.str(MAX_ID) }, ['itemId', 'expectedVersion']),
  output: S.keys('taskId', 'planVersion'),
  auditKeys: AUDIT_KEYS,
  validate: (input) => (assignShape(input) ? null : 'invalid_shape'),
  async handler(ctx, input, projectId): Promise<ToolResult> {
    const { createLedger } = await import('../../../ledger/ledger')
    const ledger = createLedger(ctx.db, { now: Date.now })
    const result = await assignControl({ projectId: projectId as string, itemId: input.itemId as string, expectedVersion: input.expectedVersion as number, ...(input.assignee ? { assignee: input.assignee as string } : {}) }, { ledger: { mode: 'on', path: '', db: ctx.db, ledger, close() {} }, enabled: isEnabled('workers', ctx.env ?? process.env) })
    const body = result.body as { taskId?: unknown; planVersion?: unknown; error?: unknown }
    return result.status === 200
      ? { ok: true, data: { taskId: String(body.taskId), planVersion: Number(body.planVersion) } }
      : { ok: false, code: String(body.error ?? 'invalid_proposal') }
  },
}

/** The four pre-registry central tools, in prompt order. */
export const CORE_DEFS: readonly ToolDef[] = [goalPropose, planPropose, taskAssign, approvalRequest]
