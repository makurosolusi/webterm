// Repository project + agent. Dipisah dari facade `ledger.ts` supaya file itu tetap di bawah
// budget service dan tiap domain punya satu tempat.
import type { Agent, CreateAgentInput, CreateProjectInput, Project } from './ledgerModel'
import {
  LedgerError,
  LedgerNotFoundError,
} from './ledgerModel'
import {
  type LedgerContext,
  allRows,
  execWrite,
  getRow,
  jsonOf,
  newId,
  requireText,
  toAgent,
  toProject,
  tx,
} from './ledgerCore'
import { clampLimit, clampOffset } from './ledgerEvent'

export function projectById(ctx: LedgerContext, id: string): Project {
  const row = getRow(ctx.db, 'SELECT * FROM project WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('project', id)
  return toProject(row)
}

export function agentById(ctx: LedgerContext, id: string): Agent {
  const row = getRow(ctx.db, 'SELECT * FROM agent WHERE id = ?', id)
  if (!row) throw new LedgerNotFoundError('agent', id)
  return toAgent(row)
}

export function projectRepository(ctx: LedgerContext) {
  const { db, now } = ctx
  return {
    createProject(input: CreateProjectInput): Project {
      const at = now()
      const id = input.id ?? newId()
      const workspaceId = requireText(input.workspaceId, 'project.workspaceId')
      const name = requireText(input.name, 'project.name')
      const path = requireText(input.path, 'project.path')
      const priority = input.priority ?? 0
      if (!Number.isInteger(priority)) {
        throw new LedgerError(`project.priority must be an integer, got ${priority}`)
      }
      try {
        execWrite(
          db,
          `INSERT INTO project (id, workspace_id, name, path, branch_base, priority, budget_json,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          workspaceId,
          name,
          path,
          input.branchBase ?? null,
          priority,
          jsonOf(input.budget, 'project.budget'),
          at,
          at
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('project.workspace_id')) {
          throw new LedgerError(`project.workspaceId already has a ledger project: ${workspaceId}`, {
            cause: err,
          })
        }
        throw err
      }
      return projectById(ctx, id)
    },
    getProject(id: string): Project | null {
      const row = getRow(db, 'SELECT * FROM project WHERE id = ?', id)
      return row ? toProject(row) : null
    },
    listProjects(opts: { limit?: number; offset?: number } = {}): Project[] {
      const limit = clampLimit(opts.limit, { def: 200, max: 1000, label: 'listProjects' })
      const offset = clampOffset(opts.offset, 'listProjects')
      return allRows(
        db,
        'SELECT * FROM project ORDER BY priority DESC, created_at ASC, id ASC LIMIT ? OFFSET ?',
        limit,
        offset
      ).map(toProject)
    },
    setLockEpoch(id: string, epoch: number): Project {
      if (!Number.isInteger(epoch) || epoch < 0) {
        throw new LedgerError(`project.lock_epoch must be a non-negative integer, got ${epoch}`)
      }
      const at = now()
      const changes = execWrite(
        db,
        'UPDATE project SET lock_epoch = ?, updated_at = ? WHERE id = ?',
        epoch,
        at,
        id
      )
      if (changes !== 1) throw new LedgerNotFoundError('project', id)
      return projectById(ctx, id)
    },
  }
}

export function agentRepository(ctx: LedgerContext) {
  const { db, now } = ctx
  return {
    createAgent(input: CreateAgentInput): Agent {
      const at = now()
      const id = input.id ?? newId()
      const projectId = requireText(input.projectId, 'agent.projectId')
      const parentAgentId = input.parentAgentId ?? null
      const name = input.name === undefined ? null : requireText(input.name, 'agent.name')
      return tx(ctx, () => {
        if (!Number.isInteger(input.depth) || input.depth < 0) {
          throw new LedgerError(`agent.depth must be a non-negative integer, got ${input.depth}`)
        }
        // Depth is derived, never trusted: the DB CHECK only caps the literal.
        let depth = input.depth
        if (parentAgentId !== null) {
          const parent = getRow(
            ctx.db,
            'SELECT project_id, depth FROM agent WHERE id = ?',
            parentAgentId
          )
          if (!parent) throw new LedgerNotFoundError('agent', parentAgentId)
          const parentProject = String(parent['project_id'])
          if (parentProject !== projectId) {
            throw new LedgerError(
              `agent.parentAgentId ${parentAgentId} belongs to project ${parentProject}, not ${projectId}`
            )
          }
          depth = Number(parent['depth']) + 1
          if (input.depth !== depth) {
            throw new LedgerError(
              `agent.depth must be ${depth} (parent ${parentAgentId} + 1), got ${input.depth}`
            )
          }
        }
        execWrite(
          db,
          `INSERT INTO agent (id, project_id, parent_agent_id, name, role, depth,
             capabilities_json, session_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          projectId,
          parentAgentId,
          name,
          input.role ?? 'worker',
          depth,
          jsonOf(input.capabilities, 'agent.capabilities'),
          input.sessionRef ?? null,
          at
        )
        return agentById(ctx, id)
      })
    },
    getAgent(id: string): Agent | null {
      const row = getRow(db, 'SELECT * FROM agent WHERE id = ?', id)
      return row ? toAgent(row) : null
    },
    setAgentState(id: string, state: string, heartbeatAt?: number): Agent {
      if (typeof state !== 'string' || state.trim() === '') {
        throw new LedgerError('agent.state must be a non-empty string')
      }
      const at = heartbeatAt ?? now()
      const changes = execWrite(
        db,
        'UPDATE agent SET state = ?, heartbeat_at = ? WHERE id = ?',
        state,
        at,
        id
      )
      if (changes !== 1) throw new LedgerNotFoundError('agent', id)
      return agentById(ctx, id)
    },
  }
}
