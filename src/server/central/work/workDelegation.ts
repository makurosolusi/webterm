import { canWorkTransition, type AssignmentChannel, type WorkStatus } from '../../../shared/centralWork'
import { WorkError, type WorkActor, type WorkStore } from './workModel'

const BUSY: readonly WorkStatus[] = ['assigned', 'running', 'waiting_input', 'stalled']
const CENTRAL: WorkActor = { kind: 'central' }
const RULE = 'delegation'
const TITLE_CHARS = 80

/** One instruction Central is about to hand to a node. */
export interface DelegationInput {
  projectId: string
  nodeId: string
  channel: AssignmentChannel
  instruction: string
  taskId?: string
  agentId?: string
  conversationId: string
  turnId?: string
}

/** Why a send did not happen; `textLeftInBox` says the prompt still waits in the node's input box (press Enter, do not retype). */
export interface SendFailure { reason: string; textLeftInBox?: boolean }
/** The durable record of a delegation; `settleFailed` undoes it when the send did not happen. */
export interface Delegation { ok: true; taskId: string; assignmentId: string; settleFailed(reason: string, detail?: Omit<SendFailure, 'reason'>): void }
/** A delegation that was recorded, or the coded reason it was refused. */
export type DelegationResult = Delegation | { ok: false; code: string; data: Record<string, unknown> }

function followUp(taskId: string, assignmentId: string): Delegation {
  return { ok: true, taskId, assignmentId, settleFailed: () => undefined }
}

/** Opens the assignment; a failed send ends it and moves the task to `restore` when that edge still exists. */
function opened(store: WorkStore, taskId: string, input: DelegationInput, restore: WorkStatus): Delegation {
  const { nodeId, channel, instruction, agentId, conversationId, turnId } = input
  const { id } = store.openAssignment({ taskId, nodeId, channel, instruction, agentId, conversationId, turnId, actor: CENTRAL, rule: RULE })
  return {
    ok: true, taskId, assignmentId: id,
    settleFailed(reason, detail = {}) {
      if (store.getAssignment(id)?.endedAt === null) store.endAssignment(id, 'send_failed', { reason, ...detail }, { actor: CENTRAL, rule: RULE })
      const current = store.getTask(taskId)
      if (current && canWorkTransition(current.status, restore)) store.moveTask(taskId, restore, { actor: CENTRAL, rule: RULE, reason, assignmentId: id })
    },
  }
}

function begin(store: WorkStore, input: DelegationInput): DelegationResult {
  const { projectId, nodeId, instruction, taskId, conversationId, turnId } = input
  if (instruction.trim() === '') return { ok: false, code: 'invalid_shape', data: { nodeId } }
  const found = store.openAssignmentOfNode(nodeId)
  // Node ids are only unique per board: another project's card under the same id is not this node's work.
  const open = found?.projectId === projectId ? found : null
  if (taskId === undefined) {
    if (open) return followUp(open.taskId, open.id)
    const title = instruction.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS)
    const created = store.createTask({ projectId, title, objective: instruction, acceptance: 'review', actor: CENTRAL, conversationId, turnId })
    return opened(store, created.id, input, 'failed')
  }
  const task = store.getTask(taskId)
  if (task?.projectId !== projectId) return { ok: false, code: 'task_not_found', data: { taskId } }
  if (open?.taskId === taskId) return followUp(taskId, open.id)
  const holder = open ? store.getTask(open.taskId) : null
  if (holder && BUSY.includes(holder.status)) return { ok: false, code: 'node_busy', data: { nodeId, taskId: holder.id } }
  if (task.status === 'failed') store.moveTask(taskId, 'todo', { actor: CENTRAL, rule: RULE })
  const restore = canWorkTransition('assigned', task.status) ? task.status : 'todo'
  const delegation = opened(store, taskId, input, restore)
  // Ended only after the new row exists, so a refused open leaves the node's previous card as it was.
  if (open) store.endAssignment(open.id, 'handed_off', undefined, { actor: CENTRAL, rule: RULE })
  return delegation
}

/** Records who was told to do what, before the side effect; every delegating tool goes through here. */
export function beginDelegation(store: WorkStore, input: DelegationInput): DelegationResult {
  try {
    return begin(store, input)
  } catch (err) {
    if (err instanceof WorkError) return { ok: false, code: err.code, data: { id: err.id } }
    throw err
  }
}

/** Runs `send`, settling the delegation as failed when it throws or `failureOf` names a code (or a code with detail). */
export async function settleSend<T>(delegation: Delegation, send: () => Promise<T>, failureOf: (sent: T) => string | SendFailure | null): Promise<T> {
  let sent: T
  try {
    sent = await send()
  } catch (err) {
    delegation.settleFailed('send_threw')
    throw new Error(`send delegation ${delegation.assignmentId} of task ${delegation.taskId}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  const failure = failureOf(sent)
  if (typeof failure === 'string') delegation.settleFailed(failure)
  else if (failure !== null) delegation.settleFailed(failure.reason, failure)
  return sent
}
