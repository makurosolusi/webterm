import type { Database } from 'bun:sqlite'
import { type LedgerContext, execWrite, getRow } from '../../../ledger/ledgerCore'
import { approvalDigest, getApproval, requestApproval } from '../../../ledger/ledgerApproval'
import { tx } from '../../../ledger/ledgerCore'
import { MAX_GOAL_ITEMS } from '../../goalModel'
import { emptyColumns, getGoal, goalCards, proposeGoal } from '../../goalStore'
import { createWorkStore } from '../../work/workStore'
import type { ToolDef, ToolResult } from '../toolTypes'
import { APPROVAL_NESTED_FORBIDDEN, FORBIDDEN_KEYS } from '../toolValidate'
import { obj, S } from '../../../capability/capability.schema'

const SAFE_ID = /^[A-Za-z0-9._:-]+$/
const MAX_REQUEST_BYTES = 8 * 1024
const MAX_ID = 200
const MAX_KIND = 100
const AUDIT_KEYS = ['approvalId', 'taskId', 'goalVersion'] as const
const MAX_TITLE = 200
const MAX_OBJECTIVE = 8000
const MAX_SCOPE_PATHS = 50
const MAX_SCOPE_CHARS = 300
const ACCEPTANCE = ['review', 'project_checks'] as const
const PLAN_ITEM_KEYS = ['title', 'objective', 'scope', 'acceptance', 'dueAt', 'blockedBy']
const UNSAFE_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

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

const goalGet: ToolDef = {
  name: 'goal.get',
  summary: 'Read a project goal and how its planned tasks stand on the board.',
  tier: 'R0',
  usage: '{"projectId":"<id>"}. goal is null when the project has none. counts are its linked tasks by board column; complete is true when every one is finished. Only the user can activate, abandon or close a goal.',
  input: obj({}),
  output: S.keys('goal', 'counts', 'total', 'complete'),
  auditKeys: ['total', 'complete'],
  validate: (input) => (Object.keys(input).every((key) => key === 'projectId') ? null : 'invalid_shape'),
  handler(ctx, _input, projectId): ToolResult {
    const card = goalCards(ctx.db, { projectId: projectId as string, limit: 1, offset: 0 }).items[0]
    return { ok: true, data: { goal: getGoal(ctx.db, projectId as string), counts: card?.counts ?? emptyColumns(), total: card?.total ?? 0, complete: card?.complete ?? false } }
  },
}

interface PlanItem { title: string; objective?: string; scope?: string[]; acceptance?: (typeof ACCEPTANCE)[number]; dueAt?: number | null; blockedBy?: number[] }

const planText = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max && !UNSAFE_TEXT.test(value)

function planItemOk(raw: unknown, index: number): boolean {
  if (!isRecord(raw) || !Object.keys(raw).every((key) => PLAN_ITEM_KEYS.includes(key)) || !planText(raw.title, MAX_TITLE)) return false
  const { objective, scope, acceptance, dueAt, blockedBy } = raw
  return (objective === undefined || planText(objective, MAX_OBJECTIVE))
    && (scope === undefined || (Array.isArray(scope) && scope.length <= MAX_SCOPE_PATHS && scope.every((path) => planText(path, MAX_SCOPE_CHARS))))
    && (acceptance === undefined || (ACCEPTANCE as readonly unknown[]).includes(acceptance))
    && (dueAt === undefined || dueAt === null || (Number.isSafeInteger(dueAt) && (dueAt as number) >= 0))
    && (blockedBy === undefined || (Array.isArray(blockedBy) && blockedBy.every((dep) => Number.isInteger(dep) && dep >= 0 && dep < index)))
}

const planPropose: ToolDef = {
  name: 'plan.propose',
  summary: 'Add planned tasks to a project board, under its goal when it has one, with dependencies.',
  tier: 'R1',
  usage: `{"projectId":"<id>","items":[{"title":"<=${MAX_TITLE} chars","objective":"<optional, what done looks like>","scope":["<files or folders it may touch>"],"acceptance":"review|project_checks","dueAt":<optional epoch ms>,"blockedBy":[<indexes of earlier items>]}]}. 1-${MAX_GOAL_ITEMS} items. Each call adds to the board and never replaces work already there. Tasks stay unassigned: hand them out with task.assign.`,
  input: obj({ items: S.arr(obj({ title: S.str(MAX_TITLE), objective: S.str(MAX_OBJECTIVE), scope: S.arr(S.str(MAX_SCOPE_CHARS), MAX_SCOPE_PATHS), acceptance: S.oneOf(...ACCEPTANCE), dueAt: { type: ['integer', 'null'], minimum: 0 }, blockedBy: S.arr(S.int(0)) }, ['title']), MAX_GOAL_ITEMS) }, ['items']),
  output: S.keys('taskIds'),
  auditKeys: ['taskIds'],
  validate: (input) => (Object.keys(input).every((key) => key === 'projectId' || key === 'items') && Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= MAX_GOAL_ITEMS && input.items.every(planItemOk) ? null : 'invalid_shape'),
  handler(ctx, input, projectId): ToolResult {
    const project = projectId as string
    const store = createWorkStore(ctx.db, ctx.now)
    const taskIds = tx({ db: ctx.db, now: ctx.now }, () => {
      const goal = getGoal(ctx.db, project)
      const goalVersion = goal?.status === 'active' || goal?.status === 'proposed' ? goal.version : null
      const lastSeq = Number(getRow(ctx.db, 'SELECT COALESCE(MAX(seq), 0) AS n FROM central_task WHERE project_id = ?', project)?.n)
      const ids: string[] = []
      ;(input.items as PlanItem[]).forEach((item, index) => {
        const { id } = store.createTask({
          projectId: project, title: item.title, objective: item.objective ?? item.title, actor: { kind: 'central' }, conversationId: ctx.conversationId,
          ...(ctx.turnId ? { turnId: ctx.turnId } : {}), ...(item.acceptance ? { acceptance: item.acceptance } : {}), dueAt: item.dueAt ?? null, boundaries: item.scope ?? null,
        })
        execWrite(ctx.db, 'UPDATE central_task SET goal_version = ?, seq = ? WHERE id = ?', goalVersion, lastSeq + index + 1, id)
        if (item.blockedBy?.length) store.setDeps(id, item.blockedBy.map((dep) => ids[dep] as string))
        ids.push(id)
      })
      return ids
    })
    return { ok: true, data: { taskIds } }
  },
}

/** The pre-registry central tools, in prompt order. */
export const CORE_DEFS: readonly ToolDef[] = [goalPropose, goalGet, planPropose, approvalRequest]
