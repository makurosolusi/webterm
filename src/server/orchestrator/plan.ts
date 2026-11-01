// Store plan di atas SQLite (tabel `plan`/`plan_item`, schema v2). Setiap mutasi
// memakai optimistic version check dan satu transaksi BEGIN IMMEDIATE.
// Bentuk data + validasi murni ada di `planModel.ts`; modul ini di-re-export lewat sini.
import {
  type AssignItemInput,
  type CreatePlanInput,
  type Plan,
  type PlanDb,
  type PlanItemInput,
  type PlanItemStatus,
  type PlanStore,
  type ReplacePlanInput,
  type UpdateItemInput,
  ITEM_TRANSITIONS,
  LIVE_ITEM_STATUSES,
  PLAN_ITEM_STATUSES,
  PLAN_STATUSES,
  PlanError,
  StalePlanVersionError,
  normalizeItems,
  toItem,
} from './planModel'

export * from './planModel'

export interface PlanStoreOptions {
  now?: () => number
  /** Injectable id generator; default crypto.randomUUID (test determinisme). */
  newId?: () => string
}

function row(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : (value as Record<string, unknown>)
}

function changed(result: unknown): number {
  return Number((result as { changes?: number } | undefined)?.changes ?? 0)
}

function requireText(value: unknown, label: string, code: 'invalid_project' | 'invalid_item'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanError(code, `${label} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Membuat store plan di atas koneksi yang sama dengan ledger P2. Pemanggil boleh
 * membungkus beberapa operasi dalam `ledger.tx`; helper tx di sini akan join.
 */
export function createPlanStore(db: PlanDb, options: PlanStoreOptions = {}): PlanStore {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => crypto.randomUUID())

  function tx<T>(fn: () => T): T {
    if (db.inTransaction === true) return fn()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // SQLite sudah rollback sendiri; tidak ada yang perlu dibatalkan.
      }
      throw err
    }
  }

  function get(projectId: string): Plan | null {
    const plan = row(db.query('SELECT * FROM plan WHERE project_id = ?').get(projectId))
    if (!plan) return null
    const items = db
      .query('SELECT * FROM plan_item WHERE plan_id = ? ORDER BY seq ASC')
      .all(String(plan['id']))
      .map((r) => toItem(r as Record<string, unknown>))
    return {
      id: String(plan['id']),
      projectId: String(plan['project_id']),
      version: Number(plan['version']),
      status: String(plan['status']) as Plan['status'],
      items,
      createdAt: Number(plan['created_at']),
      updatedAt: Number(plan['updated_at']),
    }
  }

  function requirePlan(projectId: string): Plan {
    const plan = get(projectId)
    if (!plan) throw new PlanError('plan_not_found', `no plan for project ${projectId}`)
    return plan
  }

  function requireVersion(plan: Plan, expected: number): void {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new PlanError(
        'stale_version',
        `expectedVersion must be a positive integer, got ${expected}`
      )
    }
    if (plan.version !== expected) throw new StalePlanVersionError(plan.projectId, expected, plan.version)
  }

  function bump(projectId: string, expected: number, at: number): void {
    const updated = changed(
      db
        .query(
          'UPDATE plan SET version = version + 1, updated_at = ? WHERE project_id = ? AND version = ?'
        )
        .run(at, projectId, expected)
    )
    if (updated !== 1) {
      // Baris berubah di antara read dan write (penulis lain menang lebih dulu).
      throw new StalePlanVersionError(projectId, expected, get(projectId)?.version ?? 0)
    }
  }

  function insertItems(planId: string, items: PlanItemInput[], at: number): void {
    items.forEach((item, seq) => {
      db.query(
        `INSERT INTO plan_item (id, plan_id, seq, task_id, title, scope_json, status,
           assignee, assigned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`
      ).run(newId(), planId, seq, item.taskId ?? null, item.title, JSON.stringify(item.scope), at)
    })
  }

  function requirePlanStatus(status: unknown): Plan['status'] {
    if (!PLAN_STATUSES.includes(status as Plan['status'])) {
      throw new PlanError('invalid_item', `unknown plan status ${String(status)}`)
    }
    return status as Plan['status']
  }

  function create(input: CreatePlanInput): Plan {
    const projectId = requireText(input.projectId, 'plan projectId', 'invalid_project')
    const items = normalizeItems(input.items)
    const status = input.status === undefined ? 'draft' : requirePlanStatus(input.status)
    const at = input.now ?? now()
    return tx(() => {
      if (get(projectId)) {
        throw new PlanError('plan_exists', `project ${projectId} already has a plan`)
      }
      const planId = newId()
      db.query(
        `INSERT INTO plan (id, project_id, version, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`
      ).run(planId, projectId, status, at, at)
      insertItems(planId, items, at)
      return requirePlan(projectId)
    })
  }

  function replace(input: ReplacePlanInput): Plan {
    const projectId = requireText(input.projectId, 'plan projectId', 'invalid_project')
    const items = normalizeItems(input.items)
    const status = input.status === undefined ? undefined : requirePlanStatus(input.status)
    const at = input.now ?? now()
    return tx(() => {
      const plan = requirePlan(projectId)
      requireVersion(plan, input.expectedVersion)
      if (plan.items.some((item) => LIVE_ITEM_STATUSES.includes(item.status))) {
        throw new PlanError(
          'plan_in_progress',
          `plan ${plan.id} has assigned/running items; cancel them before replacing`
        )
      }
      db.query('DELETE FROM plan_item WHERE plan_id = ?').run(plan.id)
      insertItems(plan.id, items, at)
      if (status !== undefined) {
        db.query('UPDATE plan SET status = ?, updated_at = ? WHERE id = ?').run(status, at, plan.id)
      }
      bump(projectId, input.expectedVersion, at)
      return requirePlan(projectId)
    })
  }

  function assign(input: AssignItemInput): Plan {
    const projectId = requireText(input.projectId, 'plan projectId', 'invalid_project')
    const taskId = requireText(input.taskId, 'assign taskId', 'invalid_item')
    const assignee = requireText(input.assignee, 'assign assignee', 'invalid_item')
    const at = input.now ?? now()
    return tx(() => {
      const plan = requirePlan(projectId)
      requireVersion(plan, input.expectedVersion)
      const item = plan.items.find((candidate) => candidate.id === input.itemId)
      if (!item) throw new PlanError('item_not_found', `no item ${input.itemId} in plan ${plan.id}`)
      // Assign hanya boleh sebelum spawn: item harus pending dan belum punya task.
      if (item.taskId !== null || item.status !== 'pending') {
        throw new PlanError(
          'task_already_assigned',
          `item ${item.id} is ${item.status}${item.taskId ? ` (task ${item.taskId})` : ''}; expect a pending item`
        )
      }
      if (plan.items.some((candidate) => candidate.taskId === taskId)) {
        throw new PlanError(
          'task_already_assigned',
          `task ${taskId} is already linked to another item in plan ${plan.id}`
        )
      }
      const updated = changed(
        db
          .query(
            `UPDATE plan_item SET task_id = ?, assignee = ?, assigned_at = ?, status = 'assigned',
               updated_at = ?
             WHERE id = ? AND status = 'pending' AND task_id IS NULL`
          )
          .run(taskId, assignee, at, at, item.id)
      )
      if (updated !== 1) {
        throw new PlanError('invalid_transition', `item ${item.id} changed concurrently`)
      }
      bump(projectId, input.expectedVersion, at)
      return requirePlan(projectId)
    })
  }

  function updateItem(input: UpdateItemInput): Plan {
    const projectId = requireText(input.projectId, 'plan projectId', 'invalid_project')
    const at = input.now ?? now()
    return tx(() => {
      const plan = requirePlan(projectId)
      requireVersion(plan, input.expectedVersion)
      const item = plan.items.find((candidate) => candidate.id === input.itemId)
      if (!item) throw new PlanError('item_not_found', `no item ${input.itemId} in plan ${plan.id}`)
      if (item.assignee === null || item.assignee !== input.actor) {
        throw new PlanError(
          'not_participant',
          `only assignee ${item.assignee ?? '<none>'} may update item ${item.id}, caller ${input.actor}`
        )
      }
      if (!PLAN_ITEM_STATUSES.includes(input.status as PlanItemStatus)) {
        throw new PlanError('invalid_item', `unknown item status ${String(input.status)}`)
      }
      if (!ITEM_TRANSITIONS[item.status].includes(input.status)) {
        throw new PlanError(
          'invalid_transition',
          `item ${item.id} cannot move ${item.status} -> ${input.status}`
        )
      }
      db.query('UPDATE plan_item SET status = ?, updated_at = ? WHERE id = ?').run(
        input.status,
        at,
        item.id
      )
      bump(projectId, input.expectedVersion, at)
      return requirePlan(projectId)
    })
  }

  return { get, create, replace, assign, updateItem }
}
