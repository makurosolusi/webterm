// HTTP baca untuk UI orkestrator (P3): plan, task, agent — semua SELECT. Tidak ada
// spawn/assign/verify di sini; route mutasi menyusul di lane yang sama dengan `approvalGate`.
// Otorisasi transport (token root/loopback) sudah dilakukan `index.ts` sebelum `handleApi`.
import { allRows, toAgent } from './ledger/ledgerCore'
import { TASK_STATUSES, type TaskStatus } from './ledger/ledgerModel'
import { createPlanStore } from './orchestrator/plan'
import type { LedgerRuntime } from './ledger/ledgerRuntime'

export type RouteResult = { status: number; body: unknown }

export const LEDGER_OFF: RouteResult = { status: 503, body: { error: 'ledger_off' } }
/** Ledger v1 belum punya tabel `plan` (migrasi v2); UI harus bisa membedakannya dari 500. */
const PLAN_UNAVAILABLE: RouteResult = { status: 503, body: { error: 'plan_unavailable' } }

export const ORCHESTRATOR_PREFIX = '/api/orchestrator'
const PLAN_PATH = `${ORCHESTRATOR_PREFIX}/plan`
const TASKS_PATH = `${ORCHESTRATOR_PREFIX}/tasks`
const AGENTS_PATH = `${ORCHESTRATOR_PREFIX}/agents`
const MAX_PROJECT_ID = 200
const AGENT_PAGE = 500

function projectParam(params: URLSearchParams): string | null {
  const trimmed = (params.get('projectId') ?? '').trim()
  return trimmed === '' || trimmed.length > MAX_PROJECT_ID ? null : trimmed
}

function missingPlanTable(err: unknown): boolean {
  return err instanceof Error && /no such table: plan/i.test(err.message)
}

/** `null` = bukan route orkestrator; pemanggil lanjut (termasuk 404). */
export function orchestratorRoute(
  path: string,
  method: string,
  params: URLSearchParams,
  runtime: LedgerRuntime | null
): RouteResult | null {
  if (path !== PLAN_PATH && path !== TASKS_PATH && path !== AGENTS_PATH) return null
  if (method !== 'GET') return null
  if (!runtime) return LEDGER_OFF
  const projectId = projectParam(params)
  if (projectId === null) return { status: 400, body: { error: 'invalid_project_id' } }

  if (path === TASKS_PATH) {
    const raw = params.get('status')
    if (raw !== null && !TASK_STATUSES.includes(raw as TaskStatus)) {
      return { status: 400, body: { error: 'invalid_status' } }
    }
    const status = raw === null ? undefined : (raw as TaskStatus)
    return {
      status: 200,
      body: { projectId, status: status ?? null, tasks: runtime.ledger.task.listTasks(projectId, status) },
    }
  }

  if (path === AGENTS_PATH) {
    const agents = allRows(
      runtime.db,
      'SELECT * FROM agent WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      projectId,
      AGENT_PAGE
    ).map(toAgent)
    return { status: 200, body: { projectId, agents } }
  }

  try {
    return { status: 200, body: { projectId, plan: createPlanStore(runtime.db).get(projectId) } }
  } catch (err) {
    if (missingPlanTable(err)) return PLAN_UNAVAILABLE
    throw err
  }
}
