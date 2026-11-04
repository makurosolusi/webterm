// Persistence of the task DAG (F4-b) over the ledger v16 tables. Rows only: scheduling rules live in
// `dag.scheduler.ts`, validation in `dag.model.ts`. Deps are stored as task KEYS (unique per dag).
import { allRows, execWrite, getRow, newId, tx, type LedgerContext, type Row } from '../ledger/ledgerCore'
import { DagError, validateTasks, type Brief, type DagStatus, type DagTask, type DagTaskStatus } from './dag.model'

export interface Dag {
  id: string
  projectId: string
  title: string
  repo: string
  baseRef: string
  baseBranch: string | null
  status: DagStatus
  createdBy: string
  createdAt: number
}

export interface DagDispatch {
  id: string
  taskId: string
  nodeId: string
  worktree: string | null
  branch: string | null
  baseSha: string | null
  status: 'running' | 'succeeded' | 'failed' | 'gated' | 'abandoned'
  escalation: string | null
}

export interface DagGate {
  id: string
  dagId: string
  taskId: string
  dispatchId: string | null
  approvalId: string
  question: string
  options: string[] | null
  status: 'pending' | 'approved' | 'denied'
  decidedBy: string | null
}

export interface CreateDagInput {
  projectId: string
  title: string
  repo: string
  baseRef?: string
  baseBranch?: string | null
  createdBy: string
  tasks: unknown
}

const LIST_MAX = 100
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

const toDag = (r: Row): Dag => ({
  id: String(r['id']), projectId: String(r['project_id']), title: String(r['title']), repo: String(r['repo']),
  baseRef: String(r['base_ref']), baseBranch: str(r['base_branch']), status: r['status'] as DagStatus,
  createdBy: String(r['created_by']), createdAt: Number(r['created_at']),
})
const toTask = (r: Row): DagTask => ({
  id: String(r['id']), dagId: String(r['dag_id']), key: String(r['key']), kind: r['kind'] as DagTask['kind'],
  brief: JSON.parse(String(r['brief_json'])) as Brief, deps: JSON.parse(String(r['deps_json'])) as string[],
  status: r['status'] as DagTaskStatus, failureCount: Number(r['failure_count']), lastError: str(r['last_error']), decision: str(r['decision']),
})
const toDispatch = (r: Row): DagDispatch => ({
  id: String(r['id']), taskId: String(r['task_id']), nodeId: String(r['node_id']), worktree: str(r['worktree']),
  branch: str(r['branch']), baseSha: str(r['base_sha']), status: r['status'] as DagDispatch['status'], escalation: str(r['escalation']),
})
const toGate = (r: Row): DagGate => ({
  id: String(r['id']), dagId: String(r['dag_id']), taskId: String(r['task_id']), dispatchId: str(r['dispatch_id']),
  approvalId: String(r['approval_id']), question: String(r['question']),
  options: r['options_json'] ? (JSON.parse(String(r['options_json'])) as string[]) : null,
  status: r['status'] as DagGate['status'], decidedBy: str(r['decided_by']),
})

export function createDagStore(ctx: LedgerContext) {
  const { db } = ctx
  return {
    create(input: CreateDagInput): Dag {
      const tasks = validateTasks(input.tasks)
      if (!getRow(db, 'SELECT 1 AS x FROM project WHERE id = ?', input.projectId)) throw new DagError('project_not_found', `no project ${input.projectId}`)
      const id = newId()
      const now = ctx.now()
      tx(ctx, () => {
        execWrite(db, `INSERT INTO dag (id, project_id, title, repo, base_ref, base_branch, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, input.projectId, input.title, input.repo, input.baseRef ?? 'HEAD', input.baseBranch ?? null, input.createdBy, now, now)
        for (const t of tasks) {
          execWrite(db, `INSERT INTO dag_task (id, dag_id, key, kind, brief_json, deps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            newId(), id, t.key, t.kind, JSON.stringify(t.brief), JSON.stringify(t.deps), now, now)
        }
      })
      return this.get(id)!
    },
    get: (id: string): Dag | null => { const r = getRow(db, 'SELECT * FROM dag WHERE id = ?', id); return r ? toDag(r) : null },
    list: (limit = LIST_MAX, offset = 0): Dag[] =>
      allRows(db, 'SELECT * FROM dag ORDER BY created_at DESC, id LIMIT ? OFFSET ?', Math.min(LIST_MAX, Math.max(1, limit)), Math.max(0, offset)).map(toDag),
    active: (): Dag[] => allRows(db, `SELECT * FROM dag WHERE status = 'active' ORDER BY created_at, id LIMIT ?`, LIST_MAX).map(toDag),
    setDagStatus: (id: string, status: DagStatus): void => { execWrite(db, 'UPDATE dag SET status = ?, updated_at = ? WHERE id = ?', status, ctx.now(), id) },

    tasks: (dagId: string): DagTask[] => allRows(db, 'SELECT * FROM dag_task WHERE dag_id = ? ORDER BY created_at, rowid', dagId).map(toTask),
    task: (id: string): DagTask | null => { const r = getRow(db, 'SELECT * FROM dag_task WHERE id = ?', id); return r ? toTask(r) : null },
    setTask(id: string, patch: { status?: DagTaskStatus; failureCount?: number; lastError?: string | null; decision?: string | null }): void {
      const cur = this.task(id)
      if (!cur) throw new DagError('task_not_found', `no task ${id}`)
      execWrite(db, 'UPDATE dag_task SET status = ?, failure_count = ?, last_error = ?, decision = ?, updated_at = ? WHERE id = ?',
        patch.status ?? cur.status, patch.failureCount ?? cur.failureCount,
        patch.lastError === undefined ? cur.lastError : patch.lastError, patch.decision === undefined ? cur.decision : patch.decision, ctx.now(), id)
    },

    addDispatch(d: Omit<DagDispatch, 'status' | 'escalation'>): DagDispatch {
      execWrite(db, `INSERT INTO dag_dispatch (id, task_id, node_id, worktree, branch, base_sha, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.taskId, d.nodeId, d.worktree, d.branch, d.baseSha, ctx.now())
      return this.dispatch(d.id)!
    },
    dispatch: (id: string): DagDispatch | null => { const r = getRow(db, 'SELECT * FROM dag_dispatch WHERE id = ?', id); return r ? toDispatch(r) : null },
    runningDispatches: (): DagDispatch[] => allRows(db, `SELECT * FROM dag_dispatch WHERE status = 'running'`).map(toDispatch),
    endDispatch: (id: string, status: DagDispatch['status']): void => {
      execWrite(db, 'UPDATE dag_dispatch SET status = ?, ended_at = ? WHERE id = ?', status, ctx.now(), id)
    },
    setEscalation: (id: string, reason: string): void => { execWrite(db, 'UPDATE dag_dispatch SET escalation = ? WHERE id = ?', reason, id) },

    addGate(g: Omit<DagGate, 'id' | 'status' | 'decidedBy'>): DagGate {
      const id = newId()
      execWrite(db, `INSERT INTO dag_gate (id, dag_id, task_id, dispatch_id, approval_id, question, options_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, g.dagId, g.taskId, g.dispatchId, g.approvalId, g.question, g.options ? JSON.stringify(g.options) : null, ctx.now())
      return this.gate(id)!
    },
    gate: (id: string): DagGate | null => { const r = getRow(db, 'SELECT * FROM dag_gate WHERE id = ?', id); return r ? toGate(r) : null },
    gates: (dagId: string): DagGate[] => allRows(db, 'SELECT * FROM dag_gate WHERE dag_id = ? ORDER BY created_at, rowid', dagId).map(toGate),
    pendingGates: (dagId: string): DagGate[] => allRows(db, `SELECT * FROM dag_gate WHERE dag_id = ? AND status = 'pending'`, dagId).map(toGate),
    decideGate: (id: string, status: 'approved' | 'denied', by: string): void => {
      execWrite(db, `UPDATE dag_gate SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, status, by, ctx.now(), id)
    },
    renewGate: (id: string, approvalId: string): void => { execWrite(db, 'UPDATE dag_gate SET approval_id = ? WHERE id = ?', approvalId, id) },
    approvalStatus: (approvalId: string): { status: string; by: string | null; expired: boolean } | null => {
      const r = getRow(db, 'SELECT status, approved_by, expires_at FROM approval WHERE id = ?', approvalId)
      if (!r) return null
      const exp = r['expires_at'] === null ? null : Number(r['expires_at'])
      return { status: String(r['status']), by: str(r['approved_by']), expired: String(r['status']) === 'expired' || (String(r['status']) === 'pending' && exp !== null && exp <= ctx.now()) }
    },
  }
}

export type DagStore = ReturnType<typeof createDagStore>
