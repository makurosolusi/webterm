// Task and rate-limit frames -> agent chat events, split from agentChat.events.ts. SDK shapes in
// sdk.d.ts: SDKTaskStartedMessage / SDKTaskProgressMessage / SDKTaskUpdatedMessage /
// SDKTaskNotificationMessage (system subtypes task_*) and SDKRateLimitEvent (`rate_limit_event`).
//  - Ambient / skip_transcript tasks are housekeeping (sdk.d.ts: hosts hide them): never listed.
//  - A task outlives the turn that started it (background tasks), so the map survives endTurn.
//  - rate_limit_event repeats while nothing changed: an identical state maps to nothing.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatEventBody, AgentChatTask } from '../../shared/agentChat.wire'
import { normalizeResetsAt, processRateLimit } from '../central/work/workRateLimit'

type Frame = Record<string, unknown> & { type: string; subtype?: string }
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** task_updated `patch.status` -> list status (paused/pending still count as running). */
const UPDATED: Record<string, AgentChatTask['status']> = { completed: 'completed', failed: 'failed', killed: 'stopped', running: 'running', pending: 'running', paused: 'running' }
const ENDED: Record<string, AgentChatTask['status']> = { completed: 'completed', failed: 'failed', stopped: 'stopped' }

export interface TaskMapper {
  /** Events for a task_* or rate_limit_event frame; undefined = not one of those frames. */
  map(msg: SDKMessage): AgentChatEventBody[] | undefined
  /** Conversation reset: forget every task and the last rate-limit state. */
  reset(): void
}

export function createTaskMapper(): TaskMapper {
  const tasks = new Map<string, AgentChatTask>()
  const hidden = new Set<string>()
  let lastLimit = ''

  const put = (id: string, patch: Partial<AgentChatTask>): AgentChatEventBody[] => {
    if (hidden.has(id)) return []
    const task: AgentChatTask = { ...(tasks.get(id) ?? { id, status: 'running', description: '' }), ...patch }
    tasks.set(id, task)
    return [{ t: 'task', task }]
  }

  function rateLimit(f: Frame): AgentChatEventBody[] {
    const info = (f.rate_limit_info ?? {}) as Record<string, unknown>
    const status = info.status
    if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return []
    const raw = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : undefined
    const resetsAt = raw === undefined ? undefined : normalizeResetsAt(raw)
    // Every agent chat, not only Central's own turns, holds the work-layer penalties until the limit resets (before the dedupe: repeats are idempotent).
    processRateLimit.note({ status, ...(resetsAt !== undefined ? { resetsAt } : {}) })
    const limit = str(info.rateLimitType)
    const utilization = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : undefined
    const key = `${status}|${resetsAt ?? ''}|${limit ?? ''}`
    if (key === lastLimit) return []
    lastLimit = key
    return [{ t: 'rateLimit', status, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(limit ? { limit } : {}), ...(utilization !== undefined ? { utilization } : {}) }]
  }

  function task(f: Frame): AgentChatEventBody[] | undefined {
    const id = str(f.task_id)
    if (!id) return undefined
    switch (f.subtype) {
      case 'task_started':
        if (f.ambient === true || f.skip_transcript === true) { hidden.add(id); return [] }
        return put(id, { status: 'running', description: str(f.description) ?? str(f.subagent_type) ?? 'Task', ...(str(f.tool_use_id) ? { toolUseId: str(f.tool_use_id) } : {}) })
      case 'task_progress':
        return put(id, {
          ...(str(f.description) ? { description: str(f.description) } : {}), ...(str(f.summary) ? { summary: str(f.summary) } : {}),
          ...(str(f.last_tool_name) ? { lastTool: str(f.last_tool_name) } : {}), ...(str(f.tool_use_id) ? { toolUseId: str(f.tool_use_id) } : {}),
        })
      case 'task_updated': {
        const patch = (f.patch ?? {}) as { status?: string; description?: string }
        const status = patch.status ? UPDATED[patch.status] : undefined
        if (!status && !patch.description) return []
        return put(id, { ...(status ? { status } : {}), ...(str(patch.description) ? { description: str(patch.description) } : {}) })
      }
      case 'task_notification': {
        if (f.ambient === true || f.skip_transcript === true) hidden.add(id)
        const status = ENDED[String(f.status)]
        return status ? put(id, { status, ...(str(f.summary) ? { summary: str(f.summary) } : {}) }) : []
      }
      default:
        return undefined
    }
  }

  return {
    map(msg) {
      const f = msg as unknown as Frame
      if (f.type === 'rate_limit_event') return rateLimit(f)
      if (f.type === 'system' && typeof f.subtype === 'string' && f.subtype.startsWith('task_')) return task(f)
      return undefined
    },
    reset() { tasks.clear(); hidden.clear(); lastLimit = '' },
  }
}
