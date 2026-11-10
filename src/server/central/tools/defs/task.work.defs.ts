// task.* board tools: Central plans work, hands it out and reads it back. No tool here, or anywhere in the
// registry, can mark a task done: agents report, only the user or the verifier accepts (decision 4A).
import { WORK_STATUSES, type TaskView, type WorkAcceptance, type WorkStatus } from '../../../../shared/centralWork'
import { isNodeName } from '../../../../shared/nodeNames'
import { AGENT_CHAT_KIND } from '../../../../shared/agentChat.shape'
import { obj, S, type JsonSchema } from '../../../capability/capability.schema'
import { allRows, getRow, tx } from '../../../ledger/ledgerCore'
import { PROJECT_CONVERSATION_PREFIX } from '../../conversationModel'
import type { WorkStore } from '../../work/workModel'
import { createWorkStore } from '../../work/workStore'
import type { ToolCtx, ToolDef, ToolInput, ToolResult, ToolValidationCode } from '../toolTypes'
import { FORBIDDEN_KEYS } from '../toolValidate'
import { type CanvasTypeDeps, findBoardNode, liveSession, typeInto } from './canvas.type.defs'
import { type ChatDefsDeps, MAX_CHAT_TEXT, plainText, sendChat } from './chat.defs'
import { clip, isSafeId, MAX_ID, MAX_PAGE, READ_TOOLS_FLAG, readPage } from './read.shared'

const MAX_TITLE = 200
const MAX_OBJECTIVE = 8000
const MAX_BOUNDARIES = 50
const MAX_BOUNDARY_CHARS = 300
const MAX_BLOCKED_BY = 50
const MAX_REASON = 200
const MAX_ASSIGNMENTS = 20
const TIMELINE_TAIL = 50
const OBJECTIVE_PREVIEW = 300
const ACCEPTANCE: readonly WorkAcceptance[] = ['review', 'project_checks']
const FIELD_KEYS = ['title', 'objective', 'dueAt', 'boundaries', 'acceptance']

const fail = (code: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, code, ...(data ? { data } : {}) })
const onlyKeys = (input: ToolInput, keys: readonly string[]): boolean => Object.keys(input).every((k) => keys.includes(k))
const storeOf = (ctx: ToolCtx): WorkStore => createWorkStore(ctx.db, ctx.now)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && plainText(v)
const isDue = (v: unknown): boolean => v === undefined || v === null || (Number.isSafeInteger(v) && (v as number) >= 0)
const isBoundaries = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.length <= MAX_BOUNDARIES && v.every((b) => text(b, MAX_BOUNDARY_CHARS)))
const isAcceptance = (v: unknown): boolean => v === undefined || ACCEPTANCE.includes(v as WorkAcceptance)
const conversationProject = (ctx: ToolCtx): string | null => (ctx.conversationId.startsWith(PROJECT_CONVERSATION_PREFIX) ? ctx.conversationId.slice(PROJECT_CONVERSATION_PREFIX.length) : null)

/** The task, unless a project conversation is reaching into another project (reads as not found). */
function visibleTask(ctx: ToolCtx, id: string): TaskView | null {
  const task = storeOf(ctx).getTask(id)
  const scope = conversationProject(ctx)
  return task && (scope === null || scope === task.projectId) ? task : null
}

function validateTaskRef(input: ToolInput, ctx: ToolCtx, keys: readonly string[]): ToolValidationCode | null {
  if (!onlyKeys(input, keys) || !isSafeId(input.taskId)) return 'invalid_shape'
  return visibleTask(ctx, input.taskId) ? null : 'task_not_found'
}

const brief = (t: TaskView): Record<string, unknown> => ({ ...t, objective: clip(t.objective, OBJECTIVE_PREVIEW) })
const NULLABLE_INT: JsonSchema = { type: ['integer', 'null'], minimum: 0 }
const BOUNDARIES: JsonSchema = { type: ['array', 'null'], items: S.str(MAX_BOUNDARY_CHARS), maxItems: MAX_BOUNDARIES }
const ACCEPTANCE_SCHEMA = S.oneOf(...ACCEPTANCE)

function createShape(input: ToolInput): boolean {
  const { title, objective, acceptance, dueAt, boundaries, blockedBy } = input
  return onlyKeys(input, ['projectId', 'title', 'objective', 'acceptance', 'dueAt', 'boundaries', 'blockedBy']) && text(title, MAX_TITLE) && text(objective, MAX_OBJECTIVE)
    && isAcceptance(acceptance) && isDue(dueAt) && isBoundaries(boundaries)
    && (blockedBy === undefined || (Array.isArray(blockedBy) && blockedBy.length <= MAX_BLOCKED_BY && blockedBy.every(isSafeId)))
}

function fieldsShape(fields: unknown): fields is Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false
  const f = fields as Record<string, unknown>
  return Object.keys(f).length > 0 && onlyKeys(f, FIELD_KEYS) && (f.title === undefined || text(f.title, MAX_TITLE)) && (f.objective === undefined || text(f.objective, MAX_OBJECTIVE))
    && isDue(f.dueAt) && isBoundaries(f.boundaries) && isAcceptance(f.acceptance)
}

const taskCreate: ToolDef = {
  name: 'task.create',
  summary: 'Add a task to a project board without assigning it. A task can depend on other tasks.',
  tier: 'R1',
  flag: READ_TOOLS_FLAG,
  usage: `{"projectId":"<id>","title":"<=${MAX_TITLE} chars","objective":"<=${MAX_OBJECTIVE} chars, what done looks like","acceptance":"review|project_checks","dueAt":<optional epoch ms>,"boundaries":["<files or folders it may touch>"],"blockedBy":["<task ids it waits for>"]}. Hand it out with task.assign.`,
  input: obj({ title: S.str(MAX_TITLE), objective: S.str(MAX_OBJECTIVE), acceptance: ACCEPTANCE_SCHEMA, dueAt: NULLABLE_INT, boundaries: BOUNDARIES, blockedBy: S.arr(S.str(MAX_ID), MAX_BLOCKED_BY) }, ['title', 'objective']),
  output: S.keys('taskId', 'status'),
  auditKeys: ['taskId', 'status'],
  validate(input, ctx) {
    if (!createShape(input)) return 'invalid_shape'
    const deps = [...new Set((input.blockedBy as string[] | undefined) ?? [])]
    if (deps.length === 0) return null
    // One query, whatever the dep count: a dependency must live on the same board.
    const hits = Number(getRow(ctx.db, 'SELECT COUNT(*) AS n FROM central_task WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))', String(input.projectId).trim(), JSON.stringify(deps))?.n)
    return hits === deps.length ? null : 'task_not_found'
  },
  handler(ctx, input, projectId): ToolResult {
    const store = storeOf(ctx)
    // One transaction: a refused dependency must not leave the task behind.
    const task = tx({ db: ctx.db, now: ctx.now }, () => {
      const created = store.createTask({
        projectId: projectId as string, title: input.title as string, objective: input.objective as string, actor: { kind: 'central' }, conversationId: ctx.conversationId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}), ...(input.acceptance ? { acceptance: input.acceptance as WorkAcceptance } : {}),
        dueAt: (input.dueAt as number | null | undefined) ?? null, boundaries: (input.boundaries as string[] | null | undefined) ?? null,
      })
      const deps = input.blockedBy as string[] | undefined
      return deps?.length ? store.setDeps(created.id, deps) : created
    })
    return { ok: true, data: { taskId: task.id, status: task.status } }
  },
}

const taskUpdate: ToolDef = {
  name: 'task.update',
  summary: 'Edit a task: title, objective, due date, boundaries or acceptance. Never its status.',
  tier: 'R1',
  flag: READ_TOOLS_FLAG,
  projectScoped: false,
  usage: `{"taskId":"<id>","fields":{"title":"...","objective":"...","dueAt":<epoch ms|null>,"boundaries":["..."]|null,"acceptance":"review|project_checks"}}. Give at least one field; status changes through task.assign, task.cancel and the user.`,
  input: obj({ taskId: S.str(MAX_ID), fields: S.anyObj() }, ['taskId', 'fields']),
  output: S.keys('taskId', 'projectId', 'status'),
  auditKeys: ['taskId', 'projectId'],
  validate: (input, ctx) => (fieldsShape(input.fields) ? validateTaskRef(input, ctx, ['taskId', 'fields']) : 'invalid_shape'),
  handler(ctx, input): ToolResult {
    const task = storeOf(ctx).updateTask(input.taskId as string, input.fields as Parameters<WorkStore['updateTask']>[1])
    return { ok: true, data: { taskId: task.id, projectId: task.projectId, status: task.status } }
  },
}

const taskList: ToolDef = {
  name: 'task.list',
  summary: 'List board tasks with status, newest change first; one project or all.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  projectScoped: false,
  usage: `{"projectId":"<optional; defaults to this conversation's project>","status":"<optional>","limit":<1-${MAX_PAGE}>,"offset":<n>}. Status is one of: ${WORK_STATUSES.join(', ')}.`,
  input: obj({ projectId: S.str(MAX_ID), status: S.oneOf(...WORK_STATUSES), limit: S.int(1, MAX_PAGE), offset: S.int(0) }),
  output: S.keys('tasks', 'count'),
  auditKeys: ['count'],
  // `status` is this tool's read filter; everything else stays forbidden.
  forbidden: (input) => Object.keys(input).some((k) => k !== 'status' && FORBIDDEN_KEYS.has(k)),
  validate(input, ctx) {
    if (!onlyKeys(input, ['projectId', 'status', 'limit', 'offset']) || readPage(input) === null) return 'invalid_shape'
    if (input.projectId === undefined) return null
    if (!isSafeId(input.projectId)) return 'invalid_shape'
    const scope = conversationProject(ctx)
    if (scope !== null && scope !== input.projectId) return 'conversation_project_mismatch'
    return getRow(ctx.db, 'SELECT 1 AS one FROM project WHERE id = ?', input.projectId) ? null : 'project_not_found'
  },
  handler(ctx, input): ToolResult {
    const page = readPage(input) as { limit: number; offset: number }
    const project = (input.projectId as string | undefined) ?? conversationProject(ctx)
    const tasks = storeOf(ctx).listTasks({ ...page, ...(project ? { projectId: project } : {}), ...(input.status ? { statuses: [input.status as WorkStatus] } : {}) }).map(brief)
    return { ok: true, data: { tasks, count: tasks.length } }
  },
}

const taskGet: ToolDef = {
  name: 'task.get',
  summary: 'Show one task with its assignments and the last 50 timeline events.',
  tier: 'R0',
  flag: READ_TOOLS_FLAG,
  projectScoped: false,
  usage: '{"taskId":"<id>"}. Assignments are newest first; the timeline is oldest first and shows who moved the task and why.',
  input: obj({ taskId: S.str(MAX_ID) }, ['taskId']),
  output: S.keys('task', 'assignments', 'timeline'),
  auditKeys: ['taskId'],
  validate: (input, ctx) => validateTaskRef(input, ctx, ['taskId']),
  handler(ctx, input): ToolResult {
    const taskId = input.taskId as string
    const store = storeOf(ctx)
    const total = Number(allRows(ctx.db, 'SELECT COUNT(*) AS n FROM event WHERE correlation_id = ?', taskId)[0]?.n ?? 0)
    return { ok: true, data: { taskId, task: store.getTask(taskId), assignments: store.assignmentsOfTask(taskId, MAX_ASSIGNMENTS), timeline: store.timeline(taskId, { limit: TIMELINE_TAIL, offset: Math.max(0, total - TIMELINE_TAIL) }) } }
  },
}

const taskCancel: ToolDef = {
  name: 'task.cancel',
  summary: 'Cancel a task and end its open assignment. It does not stop the agent working on it.',
  tier: 'R1',
  flag: READ_TOOLS_FLAG,
  projectScoped: false,
  usage: `{"taskId":"<id>","reason":"<=${MAX_REASON} chars"}. A task already done or cancelled answers illegal_transition.`,
  input: obj({ taskId: S.str(MAX_ID), reason: S.str(MAX_REASON) }, ['taskId', 'reason']),
  output: S.keys('taskId', 'projectId', 'status', 'assignmentId'),
  auditKeys: ['taskId', 'projectId', 'assignmentId'],
  validate: (input, ctx) => (text(input.reason, MAX_REASON) ? validateTaskRef(input, ctx, ['taskId', 'reason']) : 'invalid_shape'),
  handler(ctx, input): ToolResult {
    const store = storeOf(ctx)
    const taskId = input.taskId as string
    const reason = input.reason as string
    const actor = { kind: 'central' } as const
    const latest = store.assignmentsOfTask(taskId, 1)[0]
    const open = latest?.endedAt === null ? latest : undefined
    const task = tx({ db: ctx.db, now: ctx.now }, () => {
      const moved = store.moveTask(taskId, 'cancelled', { actor, reason, ...(open ? { assignmentId: open.id } : {}) })
      if (open) store.endAssignment(open.id, 'cancelled', { reason }, { actor })
      return moved
    })
    return { ok: true, data: { taskId, projectId: task.projectId, status: task.status, ...(open ? { assignmentId: open.id } : {}) } }
  },
}

/** Builds the task board tools; `task.assign` sends through the chat and terminal paths. */
export function createTaskWorkDefs(deps: ChatDefsDeps & Pick<CanvasTypeDeps, 'sessions'>): ToolDef[] {
  const taskAssign: ToolDef = {
    name: 'task.assign',
    summary: 'Hand a task to an Agent Chat or Claude terminal node and track it. Asks the user.',
    tier: 'R2',
    flag: READ_TOOLS_FLAG,
    usage: `{"projectId":"<id>","taskId":"<id>","nodeId":"<node id or name from node.list>","instruction":"<1-${MAX_CHAT_TEXT} chars>"}. `
      + 'Plain terminals are refused (nothing could report on them); workers you spawned take agent.prompt with taskId. Answers node_busy when the node is on another running task.',
    input: obj({ taskId: S.str(MAX_ID), nodeId: S.str(MAX_ID), instruction: S.str(MAX_CHAT_TEXT) }, ['taskId', 'nodeId', 'instruction']),
    output: S.keys('taskId', 'assignmentId', 'nodeId', 'name'),
    auditKeys: ['taskId', 'assignmentId', 'nodeId'],
    validate: (input) => (onlyKeys(input, ['projectId', 'taskId', 'nodeId', 'instruction']) && isSafeId(input.taskId) && (isSafeId(input.nodeId) || isNodeName(input.nodeId, true)) && text(input.instruction, MAX_CHAT_TEXT) ? null : 'invalid_shape'),
    async handler(ctx, input, projectId): Promise<ToolResult> {
      const found = findBoardNode(ctx, projectId, String(input.nodeId))
      if (!found.ok) return found.result
      const { node } = found
      const instruction = input.instruction as string
      const taskId = input.taskId as string
      if (node.kind === AGENT_CHAT_KIND) return sendChat(ctx, await deps.chats(), projectId, node, instruction, taskId)
      if (node.kind !== 'agent') return fail('not_trackable', { nodeId: node.id, kind: node.kind ?? null, hint: 'Only Agent Chat and Claude terminal nodes can take a tracked task; use canvas.type for a plain shell.' })
      const live = await liveSession(ctx, deps, projectId, node.id)
      if (!live.ok) return live.result
      return typeInto(ctx, projectId, live.sessions, { node, text: instruction, keys: [], submit: true, taskId })
    },
  }
  return [taskCreate, taskUpdate, taskList, taskGet, taskAssign, taskCancel]
}
